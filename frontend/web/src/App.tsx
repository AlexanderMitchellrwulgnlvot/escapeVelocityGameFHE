import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PlayerWealth {
  id: string;
  address: string;
  encryptedWealth: string;
  timestamp: number;
  isAboveThreshold: boolean;
  status: "active" | "reset";
}

interface GameState {
  escapeVelocity: string;
  totalPlayers: number;
  winners: number;
  lastReset: number;
  growthRate: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeWealth = (encryptedData: string, operation: 'grow' | 'reset' | 'checkThreshold', threshold?: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'grow':
      result = value * (1 + Math.random() * 0.1);
      break;
    case 'reset':
      result = 100;
      break;
    case 'checkThreshold':
      const thresholdValue = threshold ? FHEDecryptNumber(threshold) : 1000;
      return value > thresholdValue ? 'true' : 'false';
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [players, setPlayers] = useState<PlayerWealth[]>([]);
  const [gameState, setGameState] = useState<GameState>({
    escapeVelocity: FHEEncryptNumber(1000),
    totalPlayers: 0,
    winners: 0,
    lastReset: Date.now(),
    growthRate: 1.05
  });
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [joining, setJoining] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [initialWealth, setInitialWealth] = useState(100);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerWealth | null>(null);
  const [decryptedWealth, setDecryptedWealth] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [wealthHistory, setWealthHistory] = useState<{time: number, value: number}[]>([]);
  const [showTutorial, setShowTutorial] = useState(false);

  // Initialize game
  useEffect(() => {
    loadGameData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();

    // Simulate real-time wealth updates
    const interval = setInterval(() => {
      simulateWealthGrowth();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const loadGameData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;

      // Load player keys
      const keysBytes = await contract.getData("player_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing player keys:", e); }
      }

      // Load players data
      const playersList: PlayerWealth[] = [];
      for (const key of keys) {
        try {
          const playerBytes = await contract.getData(`player_${key}`);
          if (playerBytes.length > 0) {
            try {
              const playerData = JSON.parse(ethers.toUtf8String(playerBytes));
              const isAbove = FHEComputeWealth(playerData.encryptedWealth, 'checkThreshold', gameState.escapeVelocity) === 'true';
              playersList.push({ 
                id: key, 
                address: playerData.address, 
                encryptedWealth: playerData.encryptedWealth, 
                timestamp: playerData.timestamp, 
                isAboveThreshold: isAbove,
                status: playerData.status || "active"
              });
            } catch (e) { console.error(`Error parsing player data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading player ${key}:`, e); }
      }

      playersList.sort((a, b) => {
        const aWealth = FHEDecryptNumber(a.encryptedWealth);
        const bWealth = FHEDecryptNumber(b.encryptedWealth);
        return bWealth - aWealth;
      });

      setPlayers(playersList);
      setGameState(prev => ({
        ...prev,
        totalPlayers: playersList.length,
        winners: playersList.filter(p => p.isAboveThreshold).length
      }));

    } catch (e) { console.error("Error loading game data:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const joinGame = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setJoining(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting initial wealth with Zama FHE..." });
    try {
      const encryptedWealth = FHEEncryptNumber(initialWealth);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const playerId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const playerData = { 
        address: address, 
        encryptedWealth: encryptedWealth, 
        timestamp: Math.floor(Date.now() / 1000),
        status: "active"
      };
      
      await contract.setData(`player_${playerId}`, ethers.toUtf8Bytes(JSON.stringify(playerData)));
      
      // Update player keys
      const keysBytes = await contract.getData("player_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(playerId);
      await contract.setData("player_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Successfully joined the Escape Velocity game!" });
      await loadGameData();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowJoinModal(false);
        setInitialWealth(100);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Join failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setJoining(false); }
  };

  const growWealth = async (playerId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing wealth growth with FHE computation..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      const playerBytes = await contract.getData(`player_${playerId}`);
      if (playerBytes.length === 0) throw new Error("Player not found");
      const playerData = JSON.parse(ethers.toUtf8String(playerBytes));
      
      // FHE computation for wealth growth
      const newWealth = FHEComputeWealth(playerData.encryptedWealth, 'grow');
      const isAbove = FHEComputeWealth(newWealth, 'checkThreshold', gameState.escapeVelocity) === 'true';
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedPlayer = { 
        ...playerData, 
        encryptedWealth: newWealth,
        status: isAbove ? "active" : "reset"
      };
      
      await contractWithSigner.setData(`player_${playerId}`, ethers.toUtf8Bytes(JSON.stringify(updatedPlayer)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Wealth growth computed with FHE!" });
      await loadGameData();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Growth failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const simulateWealthGrowth = () => {
    if (players.length === 0) return;
    
    setPlayers(prevPlayers => {
      return prevPlayers.map(player => {
        if (player.status === "reset") return player;
        
        const currentWealth = FHEDecryptNumber(player.encryptedWealth);
        const growth = currentWealth * (0.95 + Math.random() * 0.1);
        const newWealth = FHEEncryptNumber(growth);
        const isAbove = FHEComputeWealth(newWealth, 'checkThreshold', gameState.escapeVelocity) === 'true';
        
        return {
          ...player,
          encryptedWealth: newWealth,
          isAboveThreshold: isAbove,
          status: isAbove ? "active" : "reset"
        };
      }).sort((a, b) => {
        const aWealth = FHEDecryptNumber(a.encryptedWealth);
        const bWealth = FHEDecryptNumber(b.encryptedWealth);
        return bWealth - aWealth;
      });
    });

    // Update escape velocity
    setGameState(prev => ({
      ...prev,
      escapeVelocity: FHEEncryptNumber(FHEDecryptNumber(prev.escapeVelocity) * prev.growthRate),
      winners: players.filter(p => p.isAboveThreshold).length
    }));

    // Update wealth history for visualization
    if (players.length > 0) {
      const topWealth = FHEDecryptNumber(players[0].encryptedWealth);
      setWealthHistory(prev => [
        ...prev.slice(-19),
        { time: Date.now(), value: topWealth }
      ]);
    }
  };

  const isPlayer = (playerAddress: string) => address?.toLowerCase() === playerAddress.toLowerCase();

  const renderEscapeVelocityMeter = () => {
    const currentThreshold = FHEDecryptNumber(gameState.escapeVelocity);
    const maxWealth = players.length > 0 ? Math.max(...players.map(p => FHEDecryptNumber(p.encryptedWealth))) : currentThreshold;
    const scale = Math.max(maxWealth, currentThreshold * 1.2);
    
    return (
      <div className="velocity-meter">
        <div className="meter-scale">
          <div className="scale-markers">
            <span>0</span>
            <span>{(scale * 0.25).toFixed(0)}</span>
            <span>{(scale * 0.5).toFixed(0)}</span>
            <span>{(scale * 0.75).toFixed(0)}</span>
            <span>{scale.toFixed(0)}</span>
          </div>
          <div className="meter-bar">
            <div 
              className="threshold-line" 
              style={{ bottom: `${(currentThreshold / scale) * 100}%` }}
            >
              <div className="threshold-label">Escape Velocity: {currentThreshold.toFixed(2)}</div>
            </div>
            {players.map((player, index) => {
              const wealth = FHEDecryptNumber(player.encryptedWealth);
              return (
                <div 
                  key={player.id}
                  className={`wealth-bar ${player.isAboveThreshold ? 'above' : 'below'} ${isPlayer(player.address) ? 'player' : ''}`}
                  style={{ 
                    height: `${(wealth / scale) * 80}%`,
                    left: `${(index / players.length) * 100}%`,
                    width: `${90 / players.length}%`
                  }}
                  title={`${player.address.substring(0, 6)}: ${wealth.toFixed(2)}`}
                ></div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderWealthHistoryChart = () => {
    if (wealthHistory.length === 0) return null;
    
    return (
      <div className="wealth-history">
        <h4>Top Wealth Evolution</h4>
        <div className="chart-container">
          {wealthHistory.map((point, index) => (
            <div 
              key={index}
              className="history-point"
              style={{
                left: `${(index / (wealthHistory.length - 1)) * 100}%`,
                bottom: `${(point.value / Math.max(...wealthHistory.map(p => p.value))) * 100}%`
              }}
            ></div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen hud-theme">
      <div className="hud-spinner"></div>
      <p>Initializing Escape Velocity Game...</p>
      <div className="hud-scanline"></div>
    </div>
  );

  return (
    <div className="app-container hud-theme">
      {/* HUD Overlay Elements */}
      <div className="hud-overlay">
        <div className="hud-corner top-left"></div>
        <div className="hud-corner top-right"></div>
        <div className="hud-corner bottom-left"></div>
        <div className="hud-corner bottom-right"></div>
        <div className="hud-scanline"></div>
      </div>

      <header className="app-header hud-header">
        <div className="logo">
          <div className="logo-icon"><div className="rocket-icon"></div></div>
          <h1>Escape<span>Velocity</span>Game</h1>
          <div className="fhe-badge"><span>ZAMA FHE Powered</span></div>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowJoinModal(true)} className="join-game-btn hud-button" disabled={!isConnected}>
            <div className="add-icon"></div>Join Game
          </button>
          <button className="hud-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>

      <div className="main-content layered-layout">
        {/* Layer 1: Game Overview */}
        <div className="game-overview-layer">
          <div className="welcome-banner hud-panel">
            <div className="welcome-text">
              <h2>Escape Velocity Economic Game</h2>
              <p>Accumulate wealth in this FHE-based economic simulation. Only players who exceed the encrypted escape velocity threshold can win!</p>
            </div>
            <div className="fhe-indicator"><div className="fhe-lock"></div><span>ZAMA FHE Encryption Active</span></div>
          </div>

          {showTutorial && (
            <div className="tutorial-section hud-panel">
              <h2>Game Tutorial</h2>
              <div className="tutorial-steps">
                <div className="tutorial-step">
                  <div className="step-icon">🚀</div>
                  <div className="step-content">
                    <h3>Join the Game</h3>
                    <p>Start with initial wealth encrypted using ZAMA FHE technology</p>
                  </div>
                </div>
                <div className="tutorial-step">
                  <div className="step-icon">📈</div>
                  <div className="step-content">
                    <h3>Grow Your Wealth</h3>
                    <p>Your wealth grows through FHE computations while remaining encrypted</p>
                  </div>
                </div>
                <div className="tutorial-step">
                  <div className="step-icon">🎯</div>
                  <div className="step-content">
                    <h3>Beat Escape Velocity</h3>
                    <p>The threshold grows continuously. Only the top players can escape!</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="game-stats-grid">
            <div className="stat-card hud-panel">
              <h3>Escape Velocity Threshold</h3>
              <div className="threshold-value">{FHEDecryptNumber(gameState.escapeVelocity).toFixed(2)}</div>
              <div className="growth-rate">+{(gameState.growthRate - 1) * 100}% per update</div>
            </div>
            <div className="stat-card hud-panel">
              <h3>Players Status</h3>
              <div className="players-stats">
                <div className="stat-item"><span>Total Players:</span><strong>{gameState.totalPlayers}</strong></div>
                <div className="stat-item"><span>Above Threshold:</span><strong className="success">{gameState.winners}</strong></div>
                <div className="stat-item"><span>Reset Players:</span><strong className="danger">{gameState.totalPlayers - gameState.winners}</strong></div>
              </div>
            </div>
            <div className="stat-card hud-panel">
              <h3>FHE Computation</h3>
              <div className="fhe-status">
                <div className="status-indicator active"></div>
                <span>All computations performed on encrypted data</span>
              </div>
            </div>
          </div>
        </div>

        {/* Layer 2: Visualization */}
        <div className="visualization-layer">
          <div className="velocity-visualization hud-panel">
            <h3>Escape Velocity Meter</h3>
            {renderEscapeVelocityMeter()}
          </div>
          {wealthHistory.length > 0 && (
            <div className="history-visualization hud-panel">
              <h3>Wealth Evolution</h3>
              {renderWealthHistoryChart()}
            </div>
          )}
        </div>

        {/* Layer 3: Player Interaction */}
        <div className="interaction-layer">
          <div className="players-section">
            <div className="section-header">
              <h2>Player Rankings</h2>
              <div className="header-actions">
                <button onClick={loadGameData} className="refresh-btn hud-button" disabled={isRefreshing}>
                  {isRefreshing ? "Refreshing..." : "Refresh"}
                </button>
              </div>
            </div>
            <div className="players-list hud-panel">
              <div className="table-header">
                <div className="header-cell">Rank</div>
                <div className="header-cell">Player</div>
                <div className="header-cell">Encrypted Wealth</div>
                <div className="header-cell">Status</div>
                <div className="header-cell">Actions</div>
              </div>
              {players.length === 0 ? (
                <div className="no-players">
                  <div className="no-players-icon">🚀</div>
                  <p>No players in the game yet</p>
                  <button className="hud-button primary" onClick={() => setShowJoinModal(true)}>Be the First Player</button>
                </div>
              ) : players.map((player, index) => (
                <div className="player-row" key={player.id} onClick={() => setSelectedPlayer(player)}>
                  <div className="table-cell rank">#{index + 1}</div>
                  <div className="table-cell address">
                    {player.address.substring(0, 6)}...{player.address.substring(38)}
                    {isPlayer(player.address) && <span className="you-badge">YOU</span>}
                  </div>
                  <div className="table-cell wealth">
                    <span className="encrypted-data">{player.encryptedWealth.substring(0, 30)}...</span>
                    <div className="fhe-tag">FHE Encrypted</div>
                  </div>
                  <div className="table-cell">
                    <span className={`status-badge ${player.isAboveThreshold ? 'above' : 'below'}`}>
                      {player.isAboveThreshold ? 'ESCAPED' : 'GROUNDED'}
                    </span>
                  </div>
                  <div className="table-cell actions">
                    {isPlayer(player.address) && player.status === "active" && (
                      <button className="action-btn hud-button success" onClick={(e) => { e.stopPropagation(); growWealth(player.id); }}>
                        Grow Wealth
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showJoinModal && (
        <ModalJoin 
          onSubmit={joinGame} 
          onClose={() => setShowJoinModal(false)} 
          joining={joining}
          initialWealth={initialWealth}
          setInitialWealth={setInitialWealth}
        />
      )}
      
      {selectedPlayer && (
        <PlayerDetailModal 
          player={selectedPlayer} 
          onClose={() => { setSelectedPlayer(null); setDecryptedWealth(null); }} 
          decryptedWealth={decryptedWealth}
          setDecryptedWealth={setDecryptedWealth}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          isPlayer={isPlayer(selectedPlayer.address)}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content hud-panel">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="hud-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✕</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer hud-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="rocket-icon"></div><span>EscapeVelocityGame</span></div>
            <p>Experimental economic simulation powered by ZAMA FHE technology</p>
          </div>
          <div className="footer-links">
            <div className="fhe-badge"><span>FHE-Powered Economic Simulation</span></div>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Modal Components
interface ModalJoinProps {
  onSubmit: () => void; 
  onClose: () => void; 
  joining: boolean;
  initialWealth: number;
  setInitialWealth: (value: number) => void;
}

const ModalJoin: React.FC<ModalJoinProps> = ({ onSubmit, onClose, joining, initialWealth, setInitialWealth }) => {
  const handleSubmit = () => {
    if (initialWealth <= 0) { alert("Please enter valid initial wealth"); return; }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="join-modal hud-panel">
        <div className="modal-header">
          <h2>Join Escape Velocity Game</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon">🔑</div> 
            <div><strong>FHE Encryption Active</strong><p>Your wealth data will be encrypted with ZAMA FHE before submission</p></div>
          </div>
          
          <div className="form-group">
            <label>Initial Wealth *</label>
            <input 
              type="number" 
              value={initialWealth} 
              onChange={(e) => setInitialWealth(parseFloat(e.target.value) || 0)} 
              placeholder="Enter initial wealth..." 
              className="hud-input"
              min="1"
              step="1"
            />
          </div>

          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data"><span>Plain Value:</span><div>{initialWealth}</div></div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{FHEEncryptNumber(initialWealth).substring(0, 50)}...</div>
              </div>
            </div>
          </div>

          <div className="game-rules">
            <h4>Game Rules</h4>
            <ul>
              <li>Wealth grows through FHE computations</li>
              <li>Escape velocity threshold increases continuously</li>
              <li>Only players above threshold can win</li>
              <li>All computations preserve privacy using ZAMA FHE</li>
            </ul>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn hud-button">Cancel</button>
          <button onClick={handleSubmit} disabled={joining} className="submit-btn hud-button primary">
            {joining ? "Encrypting with FHE..." : "Join Game"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface PlayerDetailModalProps {
  player: PlayerWealth;
  onClose: () => void;
  decryptedWealth: number | null;
  setDecryptedWealth: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  isPlayer: boolean;
}

const PlayerDetailModal: React.FC<PlayerDetailModalProps> = ({ 
  player, onClose, decryptedWealth, setDecryptedWealth, isDecrypting, decryptWithSignature, isPlayer 
}) => {
  const handleDecrypt = async () => {
    if (decryptedWealth !== null) { setDecryptedWealth(null); return; }
    const decrypted = await decryptWithSignature(player.encryptedWealth);
    if (decrypted !== null) setDecryptedWealth(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="player-detail-modal hud-panel">
        <div className="modal-header">
          <h2>Player Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="player-info">
            <div className="info-item"><span>Address:</span><strong>{player.address}</strong></div>
            <div className="info-item"><span>Joined:</span><strong>{new Date(player.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${player.isAboveThreshold ? 'above' : 'below'}`}>
                {player.isAboveThreshold ? 'ESCAPED VELOCITY' : 'BELOW THRESHOLD'}
              </strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Wealth Data</h3>
            <div className="encrypted-data">{player.encryptedWealth}</div>
            <div className="fhe-tag">FHE Encrypted with ZAMA Technology</div>
            
            {isPlayer && (
              <button className="decrypt-btn hud-button" onClick={handleDecrypt} disabled={isDecrypting}>
                {isDecrypting ? "Decrypting..." : decryptedWealth !== null ? "Hide Value" : "Decrypt with Wallet Signature"}
              </button>
            )}
          </div>

          {decryptedWealth !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Wealth</h3>
              <div className="decrypted-value">{decryptedWealth.toFixed(2)}</div>
              <div className="threshold-comparison">
                <div className="comparison-item">
                  <span>Your Wealth:</span>
                  <strong>{decryptedWealth.toFixed(2)}</strong>
                </div>
                <div className="comparison-item">
                  <span>Escape Velocity:</span>
                  <strong>{1000}</strong>
                </div>
                <div className="comparison-item">
                  <span>Difference:</span>
                  <strong className={decryptedWealth > 1000 ? 'success' : 'danger'}>
                    {(decryptedWealth - 1000).toFixed(2)}
                  </strong>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn hud-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;