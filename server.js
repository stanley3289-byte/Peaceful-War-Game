const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const crypto = require('crypto');

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const PORT = 3000;

// --- 伺服器核心狀態管理 ---
let userNames = {};      
let waitingPlayers = []; 
let gameRooms = {};      
let privateRooms = {};   
const AI_BOT_ID = 'SERVER_AI_BOT'; 
const AI_NAME = '電腦 AI';

// 設置靜態文件服務
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/client.html');
});

function createInitialGameState() {
    return {
        player1: { hp: 4, shields: 0, hasTurret: false, turretUnlocked: false, energy: 0, rpsChoice: null, name: 'Player1' },
        player2: { hp: 4, shields: 0, hasTurret: false, turretUnlocked: false, energy: 0, rpsChoice: null, name: 'Player2' },
        currentPhase: 'RPS_CHOICE', 
        turnPlayer: 'none', 
        log: ["等待雙方出拳，開始第一回合..."]
    };
}

// 啟動猜拳倒數
function startRPSTimeout(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;

    if (room.rpsTimeout) clearTimeout(room.rpsTimeout);

    room.rpsTimeout = setTimeout(() => {
        if (!gameRooms[roomId] || room.state.currentPhase !== 'RPS_CHOICE') return;

        let autoPicked = false;
        ['player1', 'player2'].forEach(role => {
            if (room.state[role].rpsChoice === null) {
                const choices = ['rock', 'scissors', 'paper'];
                room.state[role].rpsChoice = choices[Math.floor(Math.random() * choices.length)];
                autoPicked = true;
            }
        });

        if (autoPicked) {
            io.to(roomId).emit('match_info', "時間到！系統已自動代為出拳。");
            resolveRPS(roomId);
        }
    }, 5000); // *** 修改：改回 5 秒 (5000ms) ***
}

function broadcastState(roomId, message) {
    const room = gameRooms[roomId];
    if (!room) return;
    
    if (room.state.log.length >= 10) room.state.log.shift();
    room.state.log.push(message); 
    
    io.to(roomId).emit('game_state_update', room.state);
    
    // 檢查是否遊戲結束
    if (room.state.player1.hp <= 0 || room.state.player2.hp <= 0) {
        let winnerMsg = "";
        if (room.state.player1.hp <= 0 && room.state.player2.hp <= 0) {
            winnerMsg = "雙方同歸於盡！遊戲結束。";
        } else {
            const winner = room.state.player1.hp > 0 ? room.state.player1.name : room.state.player2.name;
            winnerMsg = `${winner} 獲勝! 遊戲結束。`;
        }
        
        io.to(roomId).emit('game_over', winnerMsg);
        if (room.rpsTimeout) clearTimeout(room.rpsTimeout);
        delete gameRooms[roomId];
    }
}

// --- 核心遊戲邏輯 ---

function resolveRPS(roomId) {
    const room = gameRooms[roomId];
    if (room.rpsTimeout) clearTimeout(room.rpsTimeout);

    const p1Choice = room.state.player1.rpsChoice;
    const p2Choice = room.state.player2.rpsChoice;
    
    if (!p1Choice || !p2Choice) return; 

    // --- 核彈特殊判定 ---
    // 1. 雙方都出核彈 -> 抵消，能量歸零，平手
    if (p1Choice === 'nuclear' && p2Choice === 'nuclear') {
        room.state.player1.energy = 0;
        room.state.player2.energy = 0;
        room.state.player1.rpsChoice = null;
        room.state.player2.rpsChoice = null;
        
        broadcastState(roomId, "雙方同時按下核彈按鈕！信號互相干擾抵消！(能量歸零)");
        room.state.currentPhase = 'RPS_CHOICE';
        startRPSTimeout(roomId);
        return;
    }

    // 2. 單方出核彈 -> 直接勝利
    if (p1Choice === 'nuclear') {
        room.state.player2.hp = 0; // 對手蒸發
        room.state.player1.energy = 0;
        broadcastState(roomId, `☢️ 警告！${room.state.player1.name} 發射了戰術核彈！遊戲結束！`);
        return; 
    }
    if (p2Choice === 'nuclear') {
        room.state.player1.hp = 0; // 對手蒸發
        room.state.player2.energy = 0;
        broadcastState(roomId, `☢️ 警告！${room.state.player2.name} 發射了戰術核彈！遊戲結束！`);
        return;
    }
    // -------------------

    const choiceMap = { 'rock': '✊', 'scissors': '✌️', 'paper': '🖐️' };
    const p1Symbol = choiceMap[p1Choice];
    const p2Symbol = choiceMap[p2Choice];
    
    let outcomeMessage = `${room.state.player1.name} 出 ${p1Symbol} vs ${room.state.player2.name} 出 ${p2Symbol}。`;

    room.state.player1.rpsChoice = null; 
    room.state.player2.rpsChoice = null;

    let winner = 'player2'; 
    if (p1Choice === p2Choice) {
        winner = 'draw';
    } else if (
        (p1Choice === 'rock' && p2Choice === 'scissors') ||
        (p1Choice === 'scissors' && p2Choice === 'paper') ||
        (p1Choice === 'paper' && p2Choice === 'rock')
    ) {
        winner = 'player1'; 
    }
    
    if (winner === 'draw') {
        room.state.currentPhase = 'RPS_CHOICE'; 
        broadcastState(roomId, outcomeMessage + " 平手，請重新出拳。");
        startRPSTimeout(roomId);
    } else {
        // --- 能量分配機制 ---
        const loser = winner === 'player1' ? 'player2' : 'player1';
        room.state[loser].energy += 1; // 輸家加能量

        room.state.currentPhase = 'ACTION_PHASE';
        room.state.turnPlayer = winner;
        
        broadcastState(roomId, outcomeMessage + ` 贏家 ${room.state[winner].name}！(輸家 ${room.state[loser].name} 能量+1 → 目前 ${room.state[loser].energy})`);
        
        if (room.player2Id === AI_BOT_ID && winner === 'player2') {
            handleAITurn(roomId);
        }
    }
}

function handleAITurn(roomId) {
    const room = gameRooms[roomId];
    if (!room || room.player2Id !== AI_BOT_ID) return;
    
    const opponentData = room.state.player1; 
    const actorData = room.state.player2; 
    
    setTimeout(() => {
        if (!gameRooms[roomId]) return; 

        // 1. RPS 選擇
        if (room.state.currentPhase === 'RPS_CHOICE' && actorData.rpsChoice === null) {
            // AI 簡單邏輯
            if (actorData.energy >= 20) {
                actorData.rpsChoice = 'nuclear';
            } else {
                const list = ['rock', 'scissors', 'paper'];
                actorData.rpsChoice = list[Math.floor(Math.random() * 3)];
            }
            broadcastState(roomId, `${AI_NAME} 已出拳...`);
            if (opponentData.rpsChoice) resolveRPS(roomId);
            return;
        } 
        
        // 2. 行動階段
        if (room.state.currentPhase === 'ACTION_PHASE' && room.state.turnPlayer === 'player2') {
            if (actorData.hasTurret) {
                let target = 'shield';
                if (opponentData.shields <= 0) target = 'base';
                else if (opponentData.hasTurret && Math.random() > 0.5) target = 'turret';
                processPlayerAction(roomId, 'player2', 'attack', target);
            } else {
                if (actorData.turretUnlocked && !actorData.hasTurret) { 
                    processPlayerAction(roomId, 'player2', 'turret'); 
                } else { 
                    processPlayerAction(roomId, 'player2', 'shield'); 
                }
            }
        }
    }, 1000); 
}

function processPlayerAction(roomId, role, action, target) {
    const room = gameRooms[roomId];
    if (!room || room.state.currentPhase !== 'ACTION_PHASE') return;
    
    const actor = room.state[role];
    const opponentRole = role === 'player1' ? 'player2' : 'player1';
    const opponent = room.state[opponentRole];

    let message = `${actor.name} 進行了 ${action}`;
    let actionSuccessful = true;

    if (action === 'shield') {
        actor.shields++; 
        if (actor.shields >= 3) {
            actor.turretUnlocked = true;
        }
        message = `${actor.name} 建造了護盾 (目前 ${actor.shields} 個)。`;

    } else if (action === 'turret') {
        if (actor.turretUnlocked && !actor.hasTurret) {
             actor.hasTurret = true;
             message = `${actor.name} 建造了砲台！`;
        } else {
             message = `${actor.name} 建造砲台失敗。`;
             actionSuccessful = false;
        }
    } else if (action === 'attack') {
        if (!actor.hasTurret) {
             message = `${actor.name} 嘗試攻擊，但沒有砲台。`;
             actionSuccessful = false;
        } else {
            if (target === 'shield' && opponent.shields > 0) {
                opponent.shields--;
                message = `${actor.name} 攻擊了對手的護盾，成功擊落 1 個。`;
            } else if (target === 'turret' && opponent.hasTurret) {
                opponent.hasTurret = false;
                message = `${actor.name} 攻擊了對手的砲塔，並成功摧毀！`; 
            } else if (target === 'base' && opponent.shields <= 0) {
                opponent.hp--;
                message = `${actor.name} 攻擊了對手本體，直接命中造成 1 點傷害！`;
            } else {
                message = `${actor.name} 攻擊了無效目標。`;
                actionSuccessful = false;
            }
        }
    } else {
         actionSuccessful = false;
    }
    
    if (!actionSuccessful) {
        broadcastState(roomId, message); 
        return; 
    }

    room.state.currentPhase = 'RPS_CHOICE';
    room.state.turnPlayer = 'none'; 
    
    broadcastState(roomId, message + " 行動結束，進入下一回合的猜拳。");
    startRPSTimeout(roomId);

    if (room.player2Id === AI_BOT_ID) {
        handleAITurn(roomId);
    }
}

server.listen(PORT, () => {
  console.log(`伺服器已啟動，請開啟 http://localhost:${PORT}`);
});

io.on('connection', (socket) => {
    
    socket.on('player_rps_choice', ({ roomId, choice }) => {
        const room = gameRooms[roomId];
        if (!room || room.state.currentPhase !== 'RPS_CHOICE') return; 

        const playerId = socket.id === room.player1Id ? 'player1' : 'player2';

        if (choice === 'nuclear') {
            if (room.state[playerId].energy < 20) {
                socket.emit('match_error', '能量不足，無法使用核彈！');
                return;
            }
        }

        room.state[playerId].rpsChoice = choice;
        
        if (room.player2Id === AI_BOT_ID && playerId === 'player1' && room.state.player2.rpsChoice === null) {
            handleAITurn(roomId);
        }

        broadcastState(roomId, `${room.state[playerId].name} 已出拳...`);

        if (room.state.player1.rpsChoice && room.state.player2.rpsChoice) {
            resolveRPS(roomId);
        }
    });
    
    socket.on('player_action', ({ roomId, action, target }) => {
        const room = gameRooms[roomId];
        if (!room || room.state.currentPhase !== 'ACTION_PHASE') return;
        
        const role = socket.id === room.player1Id ? 'player1' : 'player2';
        if (room.state.turnPlayer !== role) {
            socket.emit('match_error', '還沒輪到你行動!');
            return;
        }

        processPlayerAction(roomId, role, action, target);
    });

    socket.on('start_public_match', (userName) => {
        userNames[socket.id] = userName;
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        waitingPlayers.push({ id: socket.id, name: userName });
        socket.emit('match_info', "正在尋找對手...");
        matchPlayers();
    });

    socket.on('start_single_player', (userName) => {
        userNames[socket.id] = userName;
        const p1Id = socket.id;
        const roomId = crypto.randomBytes(8).toString('hex');
        
        const roomState = {
            id: roomId, player1Id: p1Id, player2Id: AI_BOT_ID, 
            p1Name: userName, p2Name: AI_NAME,
            state: createInitialGameState(),
            rpsTimeout: null 
        };
        roomState.state.player1.name = userName;
        roomState.state.player2.name = AI_NAME;
        gameRooms[roomId] = roomState;
        
        socket.join(roomId);
        io.to(p1Id).emit('game_start', { role: 'player1', roomId: roomId, opponentType: 'AI' });
        broadcastState(roomId, "單人模式開始！請出拳。");
        startRPSTimeout(roomId);
        handleAITurn(roomId);
    });
    
    socket.on('create_private_room', (userName) => {
        userNames[socket.id] = userName;
        let roomCode;
        do {
            roomCode = Math.floor(1000 + Math.random() * 9000).toString();
        } while (privateRooms[roomCode]);
        
        privateRooms[roomCode] = { 
            player1Id: socket.id, 
            player1Name: userName,
            timeout: setTimeout(() => {
                delete privateRooms[roomCode];
                io.to(socket.id).emit('match_error', '房間創建超時，已取消。');
            }, 300000) 
        };
        socket.join(roomCode);
        socket.emit('private_room_created', roomCode);
    });

    socket.on('join_private_room', ({ roomCode, userName }) => {
        const room = privateRooms[roomCode];
        if (!room) {
            socket.emit('match_error', '房間代碼無效或已滿。');
            return;
        }
        clearTimeout(room.timeout); 
        
        const p1Id = room.player1Id;
        const p2Id = socket.id;
        
        const roomId = crypto.randomBytes(8).toString('hex');
        const roomState = { 
            id: roomId, player1Id: p1Id, player2Id: p2Id, 
            p1Name: room.player1Name, p2Name: userName,
            state: createInitialGameState(),
            rpsTimeout: null 
        };
        roomState.state.player1.name = room.player1Name;
        roomState.state.player2.name = userName;
        gameRooms[roomId] = roomState;

        io.sockets.sockets.get(p1Id).join(roomId);
        socket.join(roomId); 
        
        io.to(p1Id).emit('game_start', { role: 'player1', roomId: roomId, opponentType: 'Human' });
        io.to(p2Id).emit('game_start', { role: 'player2', roomId: roomId, opponentType: 'Human' });

        delete privateRooms[roomCode];
        broadcastState(roomId, "私人遊戲開始！請出拳。");
        startRPSTimeout(roomId);
    });

    socket.on('disconnect', () => {
        for (const roomId in gameRooms) {
            const room = gameRooms[roomId];
            let opponentSocketId = null;
            let disconnectedPlayerName = userNames[socket.id] || '某位玩家';

            if (room.player1Id === socket.id) {
                opponentSocketId = room.player2Id;
            } else if (room.player2Id === socket.id) {
                opponentSocketId = room.player1Id;
            }

            if (opponentSocketId) {
                const message = `${disconnectedPlayerName} 已斷線。遊戲結束。`;
                if (opponentSocketId !== AI_BOT_ID) {
                    io.to(opponentSocketId).emit('game_over', message);
                }
                if (room.rpsTimeout) clearTimeout(room.rpsTimeout);
                delete gameRooms[roomId];
                break;
            }
        }
        delete userNames[socket.id];
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    });

    function matchPlayers() {
        if (waitingPlayers.length >= 2) {
            const p1 = waitingPlayers.shift(); 
            const p2 = waitingPlayers.shift();
            
            const roomId = crypto.randomBytes(8).toString('hex');
            
            const roomState = { 
                id: roomId, player1Id: p1.id, player2Id: p2.id, 
                p1Name: p1.name, p2Name: p2.name,
                state: createInitialGameState(),
                rpsTimeout: null
            };
            roomState.state.player1.name = p1.name;
            roomState.state.player2.name = p2.name;
            gameRooms[roomId] = roomState;
            
            io.sockets.sockets.get(p1.id).join(roomId);
            io.sockets.sockets.get(p2.id).join(roomId);

            io.to(p1.id).emit('game_start', { role: 'player1', roomId: roomId, opponentType: 'Human' });
            io.to(p2.id).emit('game_start', { role: 'player2', roomId: roomId, opponentType: 'Human' });
            broadcastState(roomId, "隨機遊戲開始！請出拳。");
            startRPSTimeout(roomId);
        }
    }
});
