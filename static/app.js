const { createApp } = Vue;

createApp({
    data() {
        return {
            simulators: [],
            queue: [],
            connected: false,
            eventSource: null,
            pollInterval: null,
            
            // Formularios / Controles
            newSimName: '',
            newSimGroup: '',
            showAddSimModal: false,
            
            // Edición de simulador
            editingSimId: null,
            editingSimName: '',
            editingSimGroup: '',
            
            // Modal de Asignación / Inicio de Sesión / Cola
            showAssignModal: false,
            selectedSimForAssign: null,
            assignFromQueueSelectedId: '',
            assignCustomGroup: '',
            assignCustomMap: 'Beat Saber',
            assignCustomDuration: 10, // en minutos
            assignCustomSimId: '',
            assignCustomPlayersCount: 1,
            
            // Mapas predefinidos
            predefinedMaps: [
                'Beat Saber',
                'Half-Life: Alyx',
                'Pavlov VR',
                'Superhot VR',
                'Richie\'s Plank Experience',
                'Job Simulator',
                'Arizona Sunshine',
                'Phasmophobia',
                'Assetto Corsa (Simulador Coches)'
            ]
        };
    },
    
    computed: {
        groupedSimulators() {
            const groups = {};
            this.simulators.forEach(sim => {
                const groupName = sim.group || 'General';
                if (!groups[groupName]) {
                    groups[groupName] = [];
                }
                groups[groupName].push(sim);
            });
            return groups;
        }
    },
    
    mounted() {
        // 1. Cargar datos inmediatamente
        this.fetchState();
        
        // 2. Siempre activar polling como método principal (funciona en todas partes)
        this.pollInterval = setInterval(this.fetchState, 2000);
        
        // 3. Intentar SSE como acelerador opcional (actualizaciones instantáneas en red local)
        this.trySSE();
        
        // 4. Temporizador local para que los segundos fluyan suavemente
        setInterval(this.localTimerTick, 1000);
    },
    
    beforeUnmount() {
        this.disconnectSSE();
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }
    },
    
    methods: {
        // --- CONEXIÓN EN TIEMPO REAL ---
        trySSE() {
            // SSE es opcional: si funciona, da actualizaciones instantáneas
            // Si no funciona (ej. a través de Cloudflare), el polling cubre la sincronización
            try {
                this.disconnectSSE();
                this.eventSource = new EventSource('/api/events');
                
                this.eventSource.onmessage = (event) => {
                    try {
                        const message = JSON.parse(event.data);
                        if (message.type === 'state') {
                            this.updateLocalState(message.data);
                            this.connected = true;
                        }
                    } catch (e) {
                        // Ignorar errores de parseo
                    }
                };
                
                this.eventSource.onerror = () => {
                    // SSE falló (normal a través de túneles/proxies)
                    // El polling sigue funcionando, así que no pasa nada
                    this.disconnectSSE();
                };
            } catch (e) {
                // Si SSE no es soportado, no hacemos nada - polling cubre todo
            }
        },
        
        disconnectSSE() {
            if (this.eventSource) {
                this.eventSource.close();
                this.eventSource = null;
            }
        },
        
        async fetchState() {
            try {
                const res = await fetch('/api/state');
                if (res.ok) {
                    const data = await res.json();
                    this.updateLocalState(data);
                    this.connected = true;
                } else {
                    this.connected = false;
                }
            } catch (e) {
                this.connected = false;
            }
        },
        
        updateLocalState(data) {
            this.simulators = data.simulators || [];
            this.queue = data.queue || [];
            
            // Pre-rellenar el simulador seleccionado por defecto para agregar a la cola
            if (!this.assignCustomSimId && this.simulators.length > 0) {
                const firstActive = this.simulators.find(s => s.active);
                this.assignCustomSimId = firstActive ? firstActive.id : this.simulators[0].id;
            }
        },
        
        // --- TIC-TAC LOCAL ---
        localTimerTick() {
            // Decrementa de manera local e instantánea el tiempo en pantalla
            // para que los segundos se muevan fluidamente sin sobrecargar al servidor.
            this.simulators.forEach(sim => {
                if (sim.status === 'playing' && sim.current_session && !sim.current_session.is_paused) {
                    if (sim.current_session.time_left > 0) {
                        sim.current_session.time_left = Math.max(0, sim.current_session.time_left - 1);
                    }
                }
            });
        },
        
        // --- FORMATEADORES ---
        formatTime(seconds) {
            if (seconds === undefined || seconds === null) return '00:00';
            const s = Math.ceil(seconds);
            if (s <= 0) return '00:00';
            
            const mins = Math.floor(s / 60);
            const secs = s % 60;
            return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        },
        
        getProgress(sim) {
            if (!sim.current_session) return 0;
            const duration = sim.current_session.duration || 600;
            const timeLeft = sim.current_session.time_left || 0;
            const elapsed = duration - timeLeft;
            const percentage = (elapsed / duration) * 100;
            return Math.min(100, Math.max(0, percentage));
        },
        
        isTimeWarning(sim) {
            // Advierte si quedan menos de 2 minutos (120 segundos)
            if (!sim.current_session) return false;
            const timeLeft = sim.current_session.time_left;
            return timeLeft > 0 && timeLeft <= 120;
        },
        
        isTimeFinished(sim) {
            if (!sim.current_session) return false;
            return sim.current_session.time_left <= 0;
        },
        
        // --- OPERACIONES DE SIMULADORES ---
        async addSimulator() {
            if (!this.newSimName.trim()) return;
            try {
                const res = await fetch('/api/simulators', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        name: this.newSimName.trim(),
                        group: this.newSimGroup.trim()
                    })
                });
                if (res.ok) {
                    this.newSimName = '';
                    this.newSimGroup = '';
                    this.showAddSimModal = false;
                }
            } catch (e) {
                alert('Error al agregar simulador');
            }
        },

        startSimEdit(sim) {
            this.editingSimId = sim.id;
            this.editingSimName = sim.name;
            this.editingSimGroup = sim.group || 'General';
        },
        
        cancelSimEdit() {
            this.editingSimId = null;
            this.editingSimName = '';
            this.editingSimGroup = '';
        },
        
        async saveSimEdit(simId) {
            if (!this.editingSimName.trim()) return;
            try {
                const res = await fetch(`/api/simulators/${simId}/edit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: this.editingSimName.trim(),
                        group: this.editingSimGroup.trim()
                    })
                });
                if (res.ok) {
                    this.editingSimId = null;
                } else {
                    alert('Error al guardar cambios');
                }
            } catch (e) {
                alert('Error de conexión');
            }
        },
        
        async toggleSimulator(sim) {
            try {
                await fetch(`/api/simulators/${sim.id}/toggle`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ active: sim.active })
                });
            } catch (e) {
                alert('Error al modificar estado del simulador');
                // Revertir cambio local
                sim.active = !sim.active;
            }
        },
        
        async deleteSimulator(simId) {
            if (!confirm('¿Estás seguro de que quieres eliminar este simulador permanentemente?')) return;
            try {
                const res = await fetch(`/api/simulators/${simId}`, {
                    method: 'DELETE'
                });
                if (!res.ok) {
                    const err = await res.json();
                    alert(err.error || 'Error al eliminar');
                }
            } catch (e) {
                alert('Error al conectar con el servidor');
            }
        },
        
        // --- OPERACIONES DE COLA ---
        async addToQueue() {
            if (!this.assignCustomGroup.trim()) return;
            if (!this.assignCustomSimId) {
                alert('Por favor selecciona un simulador');
                return;
            }
            try {
                const res = await fetch('/api/queue', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        group_name: this.assignCustomGroup.trim(),
                        map: this.assignCustomMap.trim(),
                        duration: parseInt(this.assignCustomDuration),
                        players_count: parseInt(this.assignCustomPlayersCount || 1),
                        target_sim_id: this.assignCustomSimId
                    })
                });
                if (res.ok) {
                    this.assignCustomGroup = '';
                    this.assignCustomMap = 'Beat Saber';
                    this.assignCustomDuration = 10;
                    this.assignCustomPlayersCount = 1;
                }
            } catch (e) {
                alert('Error al agregar a la lista de espera');
            }
        },
        
        async removeFromQueue(qId) {
            try {
                await fetch(`/api/queue/${qId}`, { method: 'DELETE' });
            } catch (e) {
                alert('Error al remover de la cola');
            }
        },
        
        async moveQueueItem(simId, itemIndex, direction) {
            const simQueue = this.getQueueForSim(simId);
            const targetIndex = itemIndex + direction;
            if (targetIndex < 0 || targetIndex >= simQueue.length) return;
            
            // Intercambiar en la cola filtrada del simulador
            const temp = simQueue[itemIndex];
            simQueue[itemIndex] = simQueue[targetIndex];
            simQueue[targetIndex] = temp;
            
            // Reconstruir la cola completa manteniendo el orden de otros simuladores
            const newQueue = [];
            let simQueueIdx = 0;
            this.queue.forEach(q => {
                if (q.target_sim_id === simId) {
                    newQueue.push(simQueue[simQueueIdx++]);
                } else {
                    newQueue.push(q);
                }
            });
            
            this.queue = newQueue;
            
            try {
                await fetch('/api/queue/reorder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ queue_ids: newQueue.map(q => q.id) })
                });
            } catch (e) {
                console.error('Error al guardar reorden de cola:', e);
            }
        },
        
        // --- CONTROL DE SESIONES ---
        openAssignModal(sim) {
            this.selectedSimForAssign = sim;
            this.showAssignModal = true;
            this.assignFromQueueSelectedId = '';
            
            const simQueue = this.getQueueForSim(sim.id);
            // Auto rellenar con el primero de la cola de este simulador si existe
            if (simQueue.length > 0) {
                this.assignFromQueueSelectedId = simQueue[0].id;
                this.onQueueSelectChange();
            } else {
                this.assignCustomGroup = '';
                this.assignCustomMap = 'Beat Saber';
                this.assignCustomDuration = 10;
                this.assignCustomPlayersCount = 1;
            }
        },
        
        onQueueSelectChange() {
            if (this.assignFromQueueSelectedId) {
                const selected = this.queue.find(q => q.id === this.assignFromQueueSelectedId);
                if (selected) {
                    this.assignCustomGroup = selected.group_name;
                    this.assignCustomMap = selected.map;
                    this.assignCustomDuration = Math.round(selected.duration / 60);
                    this.assignCustomPlayersCount = selected.players_count || 1;
                }
            } else {
                this.assignCustomGroup = '';
                this.assignCustomMap = 'Beat Saber';
                this.assignCustomDuration = 10;
                this.assignCustomPlayersCount = 1;
            }
        },
        
        async startSession() {
            if (!this.assignCustomGroup.trim()) {
                alert('El nombre del grupo es obligatorio');
                return;
            }
            
            const payload = {
                group_name: this.assignCustomGroup.trim(),
                map: this.assignCustomMap.trim(),
                duration: parseInt(this.assignCustomDuration),
                players_count: parseInt(this.assignCustomPlayersCount || 1)
            };
            
            if (this.assignFromQueueSelectedId) {
                payload.queue_id = this.assignFromQueueSelectedId;
            }
            
            try {
                const res = await fetch(`/api/simulators/${this.selectedSimForAssign.id}/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (res.ok) {
                    this.showAssignModal = false;
                    this.selectedSimForAssign = null;
                } else {
                    const err = await res.json();
                    alert(err.error || 'Error al iniciar sesión');
                }
            } catch (e) {
                alert('Error de conexión');
            }
        },
        
        async pauseSession(simId) {
            try {
                await fetch(`/api/simulators/${simId}/pause`, { method: 'POST' });
            } catch (e) {
                alert('Error al pausar la sesión');
            }
        },
        
        async resumeSession(simId) {
            try {
                await fetch(`/api/simulators/${simId}/resume`, { method: 'POST' });
            } catch (e) {
                alert('Error al reanudar la sesión');
            }
        },
        
        async resetSession(simId) {
            if (!confirm('¿Deseas reiniciar el temporizador de esta sesión desde el inicio?')) return;
            try {
                await fetch(`/api/simulators/${simId}/reset`, { method: 'POST' });
            } catch (e) {
                alert('Error al reiniciar la sesión');
            }
        },
        
        async stopSession(simId) {
            if (!confirm('¿Estás seguro de que quieres finalizar esta sesión? El simulador quedará libre.')) return;
            try {
                await fetch(`/api/simulators/${simId}/stop`, { method: 'POST' });
            } catch (e) {
                alert('Error al detener la sesión');
            }
        },
        
        getQueueForSim(simId) {
            return this.queue.filter(q => q.target_sim_id === simId);
        },
        
        getEstimatedWaitTime(simId, queueItemIndex) {
            const sim = this.simulators.find(s => s.id === simId);
            if (!sim) return 0;
            
            let totalWait = 0;
            if (sim.status !== 'available' && sim.current_session) {
                totalWait += sim.current_session.time_left || 0;
            }
            
            const simQueue = this.getQueueForSim(simId);
            for (let i = 0; i < queueItemIndex; i++) {
                if (simQueue[i]) {
                    totalWait += simQueue[i].duration || 0;
                }
            }
            return totalWait;
        }
    }
}).mount('#app');
