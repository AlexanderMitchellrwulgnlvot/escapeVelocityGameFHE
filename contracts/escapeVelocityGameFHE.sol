pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract EscapeVelocityGameFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidParameters();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public providers;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    uint256 public currentBatchId;
    bool public batchOpen;
    mapping(uint256 => euint32) public encryptedPlayerWealth;
    mapping(uint256 => euint32) public encryptedEscapeVelocityThreshold;
    euint32 public encryptedBaseWealth;
    euint32 public encryptedBaseThreshold;
    euint32 public encryptedThresholdGrowthRate;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event WealthSubmitted(address indexed provider, uint256 indexed playerId, euint32 encryptedWealth);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 playerWealth, uint256 escapeVelocityThreshold, bool playerEscaped);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown(address _address) {
        if (block.timestamp < lastSubmissionTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown(address _address) {
        if (block.timestamp < lastDecryptionRequestTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        providers[msg.sender] = true;
        paused = false;
        cooldownSeconds = 30; // Default cooldown
        currentBatchId = 0;
        batchOpen = false;
        emit ProviderAdded(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit ContractUnpaused();
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds == 0) revert InvalidParameters();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsUpdated(oldCooldown, newCooldownSeconds);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batchOpen) {
            currentBatchId++;
        }
        batchOpen = true;
        // Initialize encrypted state for the new batch
        encryptedBaseWealth = FHE.asEuint32(100); // Example: base wealth of 100
        encryptedBaseThreshold = FHE.asEuint32(1000); // Example: base threshold of 1000
        encryptedThresholdGrowthRate = FHE.asEuint32(50); // Example: growth rate of 50 per batch
        encryptedEscapeVelocityThreshold = _calculateInitialThreshold();
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitPlayerWealth(uint256 playerId, euint32 encryptedWealth) external onlyProvider whenNotPaused checkSubmissionCooldown(msg.sender) {
        if (!batchOpen) revert BatchNotOpen();
        _requireInitialized(encryptedWealth);
        encryptedPlayerWealth[playerId] = encryptedWealth;
        lastSubmissionTime[msg.sender] = block.timestamp;
        emit WealthSubmitted(msg.sender, playerId, encryptedWealth);
    }

    function requestEscapeCheck(uint256 playerId) external whenNotPaused checkDecryptionCooldown(msg.sender) {
        if (!batchOpen) revert BatchNotOpen();
        _requireInitialized(encryptedPlayerWealth[playerId]);
        _requireInitialized(encryptedEscapeVelocityThreshold);

        euint32 playerWealth = encryptedPlayerWealth[playerId];
        euint32 currentThreshold = encryptedEscapeVelocityThreshold;

        ebool playerEscaped = playerWealth.ge(currentThreshold);

        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(playerWealth);
        cts[1] = FHE.toBytes32(currentThreshold);
        cts[2] = FHE.toBytes32(playerEscaped);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        DecryptionContext memory context = decryptionContexts[requestId];
        if (context.processed) revert ReplayAttempt();

        euint32 playerWealth = encryptedPlayerWealth[context.batchId]; // Placeholder, actual player ID would be needed
        euint32 currentThreshold = encryptedEscapeVelocityThreshold;
        ebool playerEscaped = playerWealth.ge(currentThreshold);

        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(playerWealth);
        currentCts[1] = FHE.toBytes32(currentThreshold);
        currentCts[2] = FHE.toBytes32(playerEscaped);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != context.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidProof();

        // Decode cleartexts
        uint256 wealth = abi.decode(cleartexts[0:32], (uint256));
        uint256 threshold = abi.decode(cleartexts[32:64], (uint256));
        bool escaped = abi.decode(cleartexts[64:96], (bool));

        context.processed = true;
        decryptionContexts[requestId] = context;

        emit DecryptionCompleted(requestId, context.batchId, wealth, threshold, escaped);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 value) internal {
        if (!FHE.isInitialized(value)) {
            value = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 value) internal view {
        if (!FHE.isInitialized(value)) revert NotInitialized();
    }

    function _calculateInitialThreshold() internal view returns (euint32) {
        _requireInitialized(encryptedBaseThreshold);
        _requireInitialized(encryptedThresholdGrowthRate);
        return encryptedBaseThreshold.add(encryptedThresholdGrowthRate.mul(FHE.asEuint32(currentBatchId)));
    }
}