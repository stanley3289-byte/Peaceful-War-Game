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

// 設置靜態文件服務，讓 client.html 可以被瀏覽器讀取
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/client.html');
});

function createInitialGameState() {
    return {
        // 初始狀態：HP 4, 盾 0, 炮 無, turretUnlocked 為 "是否曾經達到3盾"
        player1: { hp: 4, shields: 0, hasTurret: false, turretUnlocked: false, rpsChoice: null, name: 'Player1' },
        player2: { hp: 4, shields: 0, hasTurret: false, turretUnlocked: false, rpsChoice: null, name: 'Player2' },
        // 遊戲一開始就進入 RPS 階段
        currentPhase: 'RPS_CHOICE', 
        turnPlayer: 'none', // 初始時沒有行動權玩家
        log: ["等待雙方出拳，開始第一回合..."]
    };
}

// *** 新增: 啟動猜拳 5 秒倒數 ***
function startRPSTimeout(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;

    // 清除舊的 Timer，防止重複
    if (room.rpsTimeout) clearTimeout(room.rpsTimeout);

    room.rpsTimeout = setTimeout(() => {
        // 確保房間還存在且仍在猜拳階段
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
    }, 5000); // 5秒
}

function broadcastState(roomId, message) {
    const room = gameRooms[roomId];
    if (!room) return;
    
    // Log 滾動 (只保留最新的 10 條)
    if (room.state.log.length >= 10) room.state.log.shift();
    room.state.log.push(message); 
    
    io.to(roomId).emit('game_state_update', room.state);
    
    // 檢查是否遊戲結束
    if (room.state.player1.hp <= 0 || room.state.player2.hp <= 0) {
        const winner = room.state.player1.hp > 0 ? room.state.player1.name : room.state.player2.name;
        io.to(roomId).emit('game_over', `${winner} 獲勝! 遊戲結束。`);
        if (room.rpsTimeout) clearTimeout(room.rpsTimeout); // 清理 Timer
        delete gameRooms[roomId];
    }
}

// --- 核心遊戲邏輯：已修正為「每回合猜拳」與「顯示結果」 ---

// 區塊 A: RPS 判斷
function resolveRPS(roomId) {
    const room = gameRooms[roomId];
    
    // *** 新增: 結算時清除計時器 ***
    if (room.rpsTimeout) clearTimeout(room.rpsTimeout);

    const p1Choice = room.state.player1.rpsChoice;
    const p2Choice = room.state.player2.rpsChoice;
    
    if (!p1Choice || !p2Choice) return; 

    // 格式化出拳文字 (用於 log 顯示)
    const choiceMap = { 'rock': '✊', 'scissors': '✌️', 'paper': '🖐️' };
    const p1Symbol = choiceMap[p1Choice];
    const p2Symbol = choiceMap[p2Choice];
    
    // 這個 outcomeMessage 包含符號，會被客戶端用來觸發結果顯示
    let outcomeMessage = `${room.state.player1.name} 出 ${p1Symbol} vs ${room.state.player2.name} 出 ${p2Symbol}。`;

    // 恢復 RPS 選擇權給下一次使用
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
        // *** 新增: 平手重來，重啟倒數 ***
        startRPSTimeout(roomId);
    } else {
        room.state.currentPhase = 'ACTION_PHASE';
        room.state.turnPlayer = winner;
        broadcastState(roomId, outcomeMessage + ` 贏家是 ${room.state[winner].name}，開始行動回合！`);
        
        if (room.player2Id === AI_BOT_ID && winner === 'player2') {
            handleAITurn(roomId);
        }
    }
}

// 區塊 B: AI 行動
function handleAITurn(roomId) {
    const room = gameRooms[roomId];
    if (!room || room.player2Id !== AI_BOT_ID) return;
    
    const opponentData = room.state.player1; 
    const actorData = room.state.player2; 
    
    setTimeout(() => {
        if (!gameRooms[roomId]) return; // 再次檢查房間是否存在

        // 1. RPS 選擇
        if (room.state.currentPhase === 'RPS_CHOICE' && actorData.rpsChoice === null) {
            const list = ['rock', 'scissors', 'paper'];
            const choice = list[Math.floor(Math.random() * 3)];
            actorData.rpsChoice = choice;
            broadcastState(roomId, `${AI_NAME} 已出拳...`);
            if (opponentData.rpsChoice) resolveRPS(roomId);
            return;
        } 
        
        // 2. 行動階段
        if (room.state.currentPhase === 'ACTION_PHASE' && room.state.turnPlayer === 'player2') {
            
            if (actorData.hasTurret) {
                // 如果有炮台，則攻擊 (簡單 AI 策略)
                let target = 'shield';
                if (opponentData.shields <= 0) target = 'base';
                else if (opponentData.hasTurret && Math.random() > 0.5) target = 'turret'; // 有炮台且隨機打炮台
                
                processPlayerAction(roomId, 'player2', 'attack', target);
                
            } else {
                // 如果沒有炮台
                // *** 修改 AI 邏輯：只要解鎖了且沒有砲台，就優先蓋砲台 ***
                if (actorData.turretUnlocked && !actorData.hasTurret) { 
                    processPlayerAction(roomId, 'player2', 'turret'); 
                } else { 
                    processPlayerAction(roomId, 'player2', 'shield'); 
                }
            }
        }
    }, 1000); 
}

// 區塊 C: 玩家行動與核心機制 - 行動結束後回到 RPS 階段
function processPlayerAction(roomId, role, action, target) {
    const room = gameRooms[roomId];
    if (!room || room.state.currentPhase !== 'ACTION_PHASE') return;
    
    const actor = room.state[role];
    const opponentRole = role === 'player1' ? 'player2' : 'player1';
    const opponent = room.state[opponentRole];

    let message = `${actor.name} 進行了 ${action}`;
    let actionSuccessful = true;

    // --- 核心行動邏輯 ---
    if (action === 'shield') {
        actor.shields++; 
        // *** 新增：如果盾牌數量達到 3，永久解鎖蓋炮台能力 ***
        if (actor.shields >= 3) {
            actor.turretUnlocked = true;
        }
        message = `${actor.name} 建造了護盾 (目前 ${actor.shields} 個)。`;

    } else if (action === 'turret') {
        // *** 修改：檢查條件改為 "是否已解鎖 (turretUnlocked)" ***
        if (actor.turretUnlocked && !actor.hasTurret) {
             actor.hasTurret = true;
             message = `${actor.name} 建造了砲台！`;
        } else {
             message = `${actor.name} 建造砲台失敗 (未曾達成3盾或已有砲台)。`;
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
                // *** 修正: 確保日誌包含 "攻擊了" 關鍵字，以觸發客戶端動畫和音效 ***
                message = `${actor.name} 攻擊了對手的砲塔，並成功摧毀！`; 
            } else if (target === 'base' && opponent.shields <= 0) {
                opponent.hp--;
                message = `${actor.name} 攻擊了對手本體，直接命中造成 1 點傷害！`;
            } else {
                message = `${actor.name} 攻擊了無效目標 (${target})。`;
                actionSuccessful = false;
            }
        }
    } else {
         message = `${actor.name} 進行了未知行動。`;
         actionSuccessful = false;
    }
    // ----------------------------------------------------------------------
    
    if (!actionSuccessful) {
        broadcastState(roomId, message); 
        return; // 行動無效，不切換回合
    }

    // *** 關鍵：行動結束後，回到 RPS 猜拳階段 ***
    room.state.currentPhase = 'RPS_CHOICE';
    room.state.turnPlayer = 'none'; // 重置行動權
    
    broadcastState(roomId, message + " 行動結束，進入下一回合的猜拳。");
    
    // *** 新增: 新回合開始，啟動倒數 ***
    startRPSTimeout(roomId);

    // 如果是單人模式，處理 AI 的 RPS 選擇
    if (room.player2Id === AI_BOT_ID) {
        handleAITurn(roomId);
    }
}


// --- 伺服器與連線處理 ---

server.listen(PORT, () => {
  console.log(`伺服器已啟動，請開啟 http://localhost:${PORT}`);
});

io.on('connection', (socket) => {
    
    // 核心遊戲邏輯：接收玩家 RPS 選擇 
    socket.on('player_rps_choice', ({ roomId, choice }) => {
        const room = gameRooms[roomId];
        if (!room || room.state.currentPhase !== 'RPS_CHOICE') return; 

        const playerId = socket.id === room.player1Id ? 'player1' : 'player2';
        room.state[playerId].rpsChoice = choice;
        
        // AI 檢查
        if (room.player2Id === AI_BOT_ID && playerId === 'player1' && room.state.player2.rpsChoice === null) {
            handleAITurn(roomId);
        }

        broadcastState(roomId, `${room.state[playerId].name} 已出拳...`);

        if (room.state.player1.rpsChoice && room.state.player2.rpsChoice) {
            resolveRPS(roomId);
        }
    });
    
    // 核心遊戲邏輯：接收玩家行動 
    socket.on('player_action', ({ roomId, action, target }) => {
        const room = gameRooms[roomId];
        if (!room || room.state.currentPhase !== 'ACTION_PHASE') return;
        
        const role = socket.id === room.player1Id ? 'player1' : 'player2';
        
        // 確保是輪到該玩家的回合
        if (room.state.turnPlayer !== role) {
            socket.emit('match_error', '還沒輪到你行動!');
            return;
        }

        processPlayerAction(roomId, role, action, target);
    });

    // 隨機配對 
    socket.on('start_public_match', (userName) => {
        userNames[socket.id] = userName;
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
        waitingPlayers.push({ id: socket.id, name: userName });
        socket.emit('match_info', "正在尋找對手...");
        matchPlayers();
    });

    // 單人模式 (AI)
    socket.on('start_single_player', (userName) => {
        userNames[socket.id] = userName;
        const p1Id = socket.id;
        const roomId = crypto.randomBytes(8).toString('hex');
        
        const roomState = {
            id: roomId, player1Id: p1Id, player2Id: AI_BOT_ID, 
            p1Name: userName, p2Name: AI_NAME,
            state: createInitialGameState(),
            rpsTimeout: null // 初始化
        };
        roomState.state.player1.name = userName;
        roomState.state.player2.name = AI_NAME;
        gameRooms[roomId] = roomState;
        
        socket.join(roomId);
        io.to(p1Id).emit('game_start', { role: 'player1', roomId: roomId, opponentType: 'AI' });
        broadcastState(roomId, "單人模式開始！請出拳。");
        
        // *** 新增: 啟動倒數 ***
        startRPSTimeout(roomId);

        handleAITurn(roomId);
    });
    
    // 私人房間創建
    socket.on('create_private_room', (userName) => {
        userNames[socket.id] = userName;
        
        // 優化: 確保房間代碼唯一性
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

    // 私人房間加入
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
            rpsTimeout: null // 初始化
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

        // *** 新增: 啟動倒數 ***
        startRPSTimeout(roomId);
    });

    // 斷線處理 (優化: 遊戲中斷線清理邏輯)
    socket.on('disconnect', () => {
        
        // 尋找並結束該玩家所在的遊戲房間
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
                
                // 通知對手遊戲結束 (AI 則無需通知)
                if (opponentSocketId !== AI_BOT_ID) {
                    io.to(opponentSocketId).emit('game_over', message);
                }
                
                // *** 新增: 清除可能存在的倒數 Timer ***
                if (room.rpsTimeout) clearTimeout(room.rpsTimeout);

                // 清理房間
                delete gameRooms[roomId];
                break;
            }
        }
        
        // 清理等待隊列和用戶名
        delete userNames[socket.id];
        waitingPlayers = waitingPlayers.filter(p => p.id !== socket.id);
    });

    // 輔助函數: 匹配等待中的玩家 
    function matchPlayers() {
        if (waitingPlayers.length >= 2) {
            const p1 = waitingPlayers.shift(); 
            const p2 = waitingPlayers.shift();
            
            const roomId = crypto.randomBytes(8).toString('hex');
            
            const roomState = { 
                id: roomId, player1Id: p1.id, player2Id: p2.id, 
                p1Name: p1.name, p2Name: p2.name,
                state: createInitialGameState(),
                rpsTimeout: null // 初始化
            };
            roomState.state.player1.name = p1.name;
            roomState.state.player2.name = p2.name;
            gameRooms[roomId] = roomState;
            
            io.sockets.sockets.get(p1.id).join(roomId);
            io.sockets.sockets.get(p2.id).join(roomId);

            io.to(p1.id).emit('game_start', { role: 'player1', roomId: roomId, opponentType: 'Human' });
            io.to(p2.id).emit('game_start', { role: 'player2', roomId: roomId, opponentType: 'Human' });
            broadcastState(roomId, "隨機遊戲開始！請出拳。");
            
            // *** 新增: 啟動倒數 ***
            startRPSTimeout(roomId);
        }
    }

});
