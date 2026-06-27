# -*- coding: utf-8 -*-
from flask import Flask, Response, jsonify, request, stream_with_context
import json
import os
import time
import uuid
import queue
import threading

# Detectar si estamos en producción (Render asigna la variable PORT)
IS_PRODUCTION = 'PORT' in os.environ

app = Flask(__name__, static_folder='static', static_url_path='')

DATA_FILE = 'data.json'

# --- MODELO DE DATOS Y PERSISTENCIA ---

def load_data():
    default_state = {
        "simulators": [
            {
                "id": "sim_1",
                "name": "Simulador 1 (VR Racing)",
                "active": True,
                "status": "available", # 'available', 'playing', 'paused'
                "current_session": None
            },
            {
                "id": "sim_2",
                "name": "Simulador 2 (VR Stand)",
                "active": True,
                "status": "available",
                "current_session": None
            },
            {
                "id": "sim_3",
                "name": "Simulador 3 (Oculus Quest)",
                "active": True,
                "status": "available",
                "current_session": None
            }
        ],
        "queue": []
    }
    
    if os.path.exists(DATA_FILE):
        try:
            with open(DATA_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading {DATA_FILE}, using defaults: {e}")
            return default_state
    return default_state

state = load_data()

def save_data():
    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"Error saving data: {e}")

# --- CÁLCULO DE TIEMPO REAL ---

def get_current_state():
    """
    Retorna el estado de la aplicación calculando dinámicamente el tiempo restante
    de las sesiones activas en base a marcas de tiempo de Unix (time.time()).
    """
    now = time.time()
    computed_simulators = []
    
    for sim in state["simulators"]:
        sim_copy = sim.copy()
        if sim["status"] in ("playing", "paused") and sim["current_session"]:
            sess = sim["current_session"].copy()
            
            # Calcular tiempo transcurrido
            if sess["is_paused"]:
                total_elapsed = sess["elapsed_time"]
            else:
                elapsed_since_start = now - sess["started_at"]
                total_elapsed = sess["elapsed_time"] + elapsed_since_start
            
            # Calcular tiempo restante
            time_left = sess["duration"] - total_elapsed
            sess["time_left"] = max(0.0, time_left)
            sim_copy["current_session"] = sess
        computed_simulators.append(sim_copy)
        
    return {
        "simulators": computed_simulators,
        "queue": state["queue"]
    }

# --- SERVER-SENT EVENTS (SSE) BROADCAST ---

class PubSub:
    def __init__(self):
        self.listeners = []
        self._lock = threading.Lock()
        
    def listen(self):
        q = queue.Queue(maxsize=20)
        with self._lock:
            self.listeners.append(q)
        return q
        
    def remove(self, q):
        with self._lock:
            if q in self.listeners:
                self.listeners.remove(q)
            
    def broadcast_state(self):
        current = get_current_state()
        msg = {
            "type": "state",
            "data": current
        }
        payload = f"data: {json.dumps(msg, ensure_ascii=False)}\n\n"
        with self._lock:
            dead = []
            for q in self.listeners:
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    try:
                        q.get_nowait()
                        q.put_nowait(payload)
                    except Exception:
                        dead.append(q)
            for q in dead:
                self.listeners.remove(q)

pubsub = PubSub()

# --- RUTAS DE ARCHIVOS ESTÁTICOS ---

@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/admin')
def admin():
    return app.send_static_file('admin.html')

# --- RUTAS DE API ---

@app.route('/api/state', methods=['GET'])
def api_get_state():
    return jsonify(get_current_state())

@app.route('/api/events', methods=['GET'])
def api_events():
    """
    Canal de eventos SSE para actualización en tiempo real en clientes.
    """
    q = pubsub.listen()
    def respond():
        try:
            # Enviar el estado inicial al conectar
            initial_state = {
                "type": "state",
                "data": get_current_state()
            }
            yield f"data: {json.dumps(initial_state, ensure_ascii=False)}\n\n"
            
            while True:
                try:
                    # Esperar mensaje o hacer un ping cada 10 segundos
                    msg = q.get(timeout=10.0)
                    yield msg
                except queue.Empty:
                    yield ": ping\n\n"
        except GeneratorExit:
            pass
        finally:
            pubsub.remove(q)

    response = Response(
        stream_with_context(respond()),
        mimetype='text/event-stream'
    )
    # Cabeceras anti-buffering para proxies (Cloudflare, Nginx, etc.)
    response.headers['Cache-Control'] = 'no-cache, no-transform'
    response.headers['Connection'] = 'keep-alive'
    response.headers['X-Accel-Buffering'] = 'no'
    return response

# --- ADMINISTRACIÓN DE SIMULADORES ---

@app.route('/api/simulators', methods=['POST'])
def add_simulator():
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({"error": "El nombre es requerido"}), 400
        
    sim_id = f"sim_{uuid.uuid4().hex[:8]}"
    new_sim = {
        "id": sim_id,
        "name": name,
        "active": True,
        "status": "available",
        "current_session": None
    }
    state["simulators"].append(new_sim)
    save_data()
    pubsub.broadcast_state()
    return jsonify(new_sim)

@app.route('/api/simulators/<sim_id>/toggle', methods=['POST'])
def toggle_simulator(sim_id):
    data = request.json
    active = data.get('active', True)
    
    found = False
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            sim["active"] = active
            # Si se desactiva, finalizamos la sesión activa si la hubiera
            if not active:
                sim["status"] = "available"
                sim["current_session"] = None
            found = True
            break
            
    if not found:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

@app.route('/api/simulators/<sim_id>/edit', methods=['POST'])
def edit_simulator(sim_id):
    data = request.json
    name = data.get('name', '').strip()
    if not name:
        return jsonify({"error": "El nombre es requerido"}), 400
        
    found = False
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            sim["name"] = name
            found = True
            break
            
    if not found:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

@app.route('/api/simulators/<sim_id>', methods=['DELETE'])
def delete_simulator(sim_id):
    global state
    original_len = len(state["simulators"])
    state["simulators"] = [s for s in state["simulators"] if s["id"] != sim_id]
    
    if len(state["simulators"]) == original_len:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

# --- ADMINISTRACIÓN DE LA COLA (LISTA DE ESPERA) ---

@app.route('/api/queue', methods=['POST'])
def add_to_queue():
    data = request.json
    group_name = data.get('group_name', '').strip()
    map_name = data.get('map', '').strip()
    duration_mins = data.get('duration', 10) # En minutos
    
    if not group_name:
        return jsonify({"error": "El nombre del grupo es requerido"}), 400
        
    q_id = f"q_{uuid.uuid4().hex[:8]}"
    new_entry = {
        "id": q_id,
        "group_name": group_name,
        "map": map_name or "Por definir",
        "duration": duration_mins * 60, # Guardar en segundos
        "created_at": time.time()
    }
    state["queue"].append(new_entry)
    save_data()
    pubsub.broadcast_state()
    return jsonify(new_entry)

@app.route('/api/queue/<q_id>', methods=['DELETE'])
def remove_from_queue(q_id):
    global state
    original_len = len(state["queue"])
    state["queue"] = [q for q in state["queue"] if q["id"] != q_id]
    
    if len(state["queue"]) == original_len:
        return jsonify({"error": "Elemento de cola no encontrado"}), 404
        
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

@app.route('/api/queue/reorder', methods=['POST'])
def reorder_queue():
    data = request.json
    queue_ids = data.get('queue_ids', [])
    
    # Crear un diccionario para búsqueda rápida
    queue_map = {q["id"]: q for q in state["queue"]}
    
    new_queue = []
    for q_id in queue_ids:
        if q_id in queue_map:
            new_queue.append(queue_map[q_id])
            
    # Si faltó alguno por enviar, lo añadimos al final por seguridad
    sent_ids = set(queue_ids)
    for q in state["queue"]:
        if q["id"] not in sent_ids:
            new_queue.append(q)
            
    state["queue"] = new_queue
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

# --- CONTROL DE SESIONES ---

@app.route('/api/simulators/<sim_id>/start', methods=['POST'])
def start_session(sim_id):
    data = request.json or {}
    group_name = data.get('group_name', '').strip()
    map_name = data.get('map', '').strip()
    duration_mins = data.get('duration', 10)
    queue_id = data.get('queue_id') # Opcional: si proviene de la cola
    
    # Buscar el simulador
    target_sim = None
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            target_sim = sim
            break
            
    if not target_sim:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    if not target_sim["active"]:
        return jsonify({"error": "El simulador está inactivo"}), 400
        
    # Validar que si iniciamos sesión, el simulador esté disponible
    # O, si ya está ocupado, podemos sobrescribirlo (el admin manda)
    
    # Si no se pasó nombre de grupo pero hay sesión pausada, hacemos resume
    if not group_name and target_sim["status"] == "paused" and target_sim["current_session"]:
        # Resume
        sess = target_sim["current_session"]
        sess["started_at"] = time.time()
        sess["is_paused"] = False
        target_sim["status"] = "playing"
    else:
        # Nueva sesión
        if not group_name:
            return jsonify({"error": "El nombre del grupo es requerido para iniciar sesión"}), 400
            
        target_sim["status"] = "playing"
        target_sim["current_session"] = {
            "group_name": group_name,
            "map": map_name or "Beat Saber",
            "duration": duration_mins * 60,
            "started_at": time.time(),
            "elapsed_time": 0.0,
            "is_paused": False
        }
        
        # Eliminar de la cola si venía de ahí
        if queue_id:
            state["queue"] = [q for q in state["queue"] if q["id"] != queue_id]
            
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

@app.route('/api/simulators/<sim_id>/pause', methods=['POST'])
def pause_session(sim_id):
    target_sim = None
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            target_sim = sim
            break
            
    if not target_sim:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    if target_sim["status"] == "playing" and target_sim["current_session"]:
        sess = target_sim["current_session"]
        # Acumular el tiempo transcurrido
        sess["elapsed_time"] += time.time() - sess["started_at"]
        sess["is_paused"] = True
        sess["started_at"] = None
        target_sim["status"] = "paused"
        
        save_data()
        pubsub.broadcast_state()
        return jsonify({"success": True})
        
    return jsonify({"error": "El simulador no está en juego"}), 400

@app.route('/api/simulators/<sim_id>/resume', methods=['POST'])
def resume_session(sim_id):
    target_sim = None
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            target_sim = sim
            break
            
    if not target_sim:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    if target_sim["status"] == "paused" and target_sim["current_session"]:
        sess = target_sim["current_session"]
        sess["started_at"] = time.time()
        sess["is_paused"] = False
        target_sim["status"] = "playing"
        
        save_data()
        pubsub.broadcast_state()
        return jsonify({"success": True})
        
    return jsonify({"error": "La sesión no está pausada"}), 400

@app.route('/api/simulators/<sim_id>/reset', methods=['POST'])
def reset_session(sim_id):
    target_sim = None
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            target_sim = sim
            break
            
    if not target_sim:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    if target_sim["current_session"]:
        sess = target_sim["current_session"]
        sess["started_at"] = time.time()
        sess["elapsed_time"] = 0.0
        sess["is_paused"] = False
        target_sim["status"] = "playing"
        
        save_data()
        pubsub.broadcast_state()
        return jsonify({"success": True})
        
    return jsonify({"error": "No hay sesión activa para reiniciar"}), 400

@app.route('/api/simulators/<sim_id>/stop', methods=['POST'])
def stop_session(sim_id):
    target_sim = None
    for sim in state["simulators"]:
        if sim["id"] == sim_id:
            target_sim = sim
            break
            
    if not target_sim:
        return jsonify({"error": "Simulador no encontrado"}), 404
        
    target_sim["status"] = "available"
    target_sim["current_session"] = None
    
    save_data()
    pubsub.broadcast_state()
    return jsonify({"success": True})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    if IS_PRODUCTION:
        # En producción (Render), sin debug
        app.run(host='0.0.0.0', port=port, threaded=True)
    else:
        # En desarrollo local, con debug y recarga automática
        app.run(host='0.0.0.0', port=port, debug=True, threaded=True)
