const { ethers } = require("ethers");

// --- Config ---
const RPC = "https://base-mainnet.g.alchemy.com/v2/...";
const PRIVATE_KEY = "0x...";
const TOMB_ADDRESS = "0xf4ccA71492c66f4E4652bca6f591afFb178978E1";
const AERO_CONTRACT = "0x3725bD4D175283108156c3F15f86e1c51266155d";
const CBBTC_BRIDGE = "0x23a7A15fE3Ed7b0899D6D19Fb6ad3DB312d0b30D";
const SELECTORS = ["0xfb3bdb41", "0x01000000", "0x5c11d795", "0x18cbafe5", "0x5c11d795"];

const provider = new ethers.providers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// --- Contracts ---
const tomb = new ethers.Contract(TOMB_ADDRESS, [
    "function emitCascade(string signal, uint256 royaltyBps) external",
    "function claimYield(string signal) external",
    "function getSignalStatus(string signal) external view returns (bool active, uint256 royalty, uint256 yield)"
], wallet);

const bridgeInterface = new ethers.utils.Interface([
    "event BridgeRequest(address indexed from, uint256 amount)",
    "event BridgeComplete(bytes32 indexed requestId, uint256 amount)"
]);

// --- State Management ---
let budCounter = 1;
let lastSignalHash = null;
let bridgeRequests = new Map();
const fibs = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];
const retryQueue = [];

// --- Core Functions ---
const hashSignal = (signal) =>
    ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["string"], [signal]));

const hashChild = (signalHash, block, entropy) =>
    ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256", "bytes32"], [signalHash, block, entropy]));

const extractEntropy = (tx) =>
    ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "bytes"], [tx.from, tx.data]));

const calculateRoyalty = (amountIn, minOut) => {
    if (typeof amountIn === 'string' && amountIn.startsWith('bridge_')) {
        return 2; // Higher royalty for bridge signals
    }
    const bigAmountIn = ethers.BigNumber.from(amountIn);
    const bigMinOut = ethers.BigNumber.from(minOut);
    const delta = bigAmountIn.sub(bigMinOut).abs();
    const ratio = delta.mul(1000000).div(bigAmountIn);
    if (ratio.lt(1)) return 1;
    if (ratio.gt(1)) return 1;
    return ratio.toNumber();
};

const getGasDelta = (txGas, blockGasUsed, txCount) => {
    const median = ethers.BigNumber.from(blockGasUsed).div(txCount || 1);
    const delta = ethers.BigNumber.from(txGas).sub(median);
    return delta.isNegative() ? "low" : delta.gt(median.div(2)) ? "high" : "mid";
};

const getPhiIndex = (blockNumber) =>
    fibs.find(f => blockNumber % f === 0) || 0;

// --- Enhanced Emit + Claim ---
async function emitAndClaim(signal, blockNumber) {
    const nonce = await provider.getTransactionCount(wallet.address, "pending");
    const parsed = JSON.parse(signal);
    const signalHash = hashSignal(signal);
    const childHash = parsed.intent.startsWith('bridge_') ? 
        hashChild(signalHash, blockNumber, ethers.utils.id('bridge')) :
        hashChild(signalHash, blockNumber, parsed.kws);
    
    const status = await tomb.getSignalStatus(signal);

    if (status.active) {
        console.log(`skipped, already active`);
        return;
    }

    const royaltyBps = parsed.intent.startsWith('bridge_') ? 2 : calculateRoyalty(parsed.in, parsed.out);
    const gasLimit = ethers.BigNumber.from("340000");
    const baseGas = ethers.utils.parseUnits("0.000618", "gwei");
    const bumpStep = ethers.utils.parseUnits("0.0000618", "gwei");
    const maxGas = ethers.utils.parseUnits("0.618", "gwei");
    const maxRetries = 13;

    let gasBump = ethers.BigNumber.from("0");
    let retryCount = 0;

    while (retryCount < maxRetries) {
        const bumpedGas = baseGas.add(gasBump);
        if (bumpedGas.gt(maxGas)) {
            console.log(`max gas exceeded`);
            return;
        }

        try {
            const currentNonce = await provider.getTransactionCount(wallet.address, "pending");
            
            const tx = await tomb.emitCascade(signal, royaltyBps, {
                nonce: currentNonce,
                gasLimit,
                maxFeePerGas: bumpedGas,
                maxPriorityFeePerGas: bumpedGas
            });

            console.log(`minted: ${tx.hash}, bps: ${royaltyBps}, nonce: ${currentNonce} [${blockNumber}]`);
            lastSignalHash = signalHash;
            retryQueue.push({ signal, blockNumber });
            break;
        } catch (err) {
            if (err.code === "REPLACEMENT_UNDERPRICED" || err.code === "NONCE_EXPIRED") {
                gasBump = gasBump.add(bumpStep);
                retryCount++;
                await new Promise(res => setTimeout(res, 300 * Math.pow(2, retryCount)));
            } else {
                console.log(`mint failed: ${err.message} [${blockNumber}]`);
                return;
            }
        }
    }

    if (retryCount >= maxRetries) {
        console.log(`max attempts reached`);
    }
}

// --- Bridge Monitor ---
async function processBridgeEvent(blockNumber, log) {
    try {
        const parsedLog = bridgeInterface.parseLog(log);
        if (parsedLog.name === "BridgeRequest") {
            const amount = parsedLog.args.amount;
            const from = parsedLog.args.from;
            
            const signalRaw = {
                tag: `bridge_${blockNumber}_${from.slice(0,6)}`,
                intent: "bridge_incoming",
                path: ["cbBTC", "WETH"],
                amount: amount.toString(),
                bridgeFrom: from,
                blk: blockNumber,
                phi: getPhiIndex(blockNumber),
                ts: Math.floor(Date.now() / 1000),
                kws: ethers.utils.id('bridge'),
                parent: lastSignalHash || "0x0"
            };

            const signal = JSON.stringify(signalRaw);
            await emitAndClaim(signal, blockNumber);
            
            bridgeRequests.set(blockNumber, {
                amount,
                from,
                timestamp: Date.now()
            });
            
            console.log(`Bridge signal: ${from} -> ${amount.toString()} [${blockNumber}]`);
        }
    } catch (err) {
        console.log(`Bridge event error: ${err.message}`);
    }
}

// --- Main Block Listener ---
provider.on("block", async (blockNumber) => {
    // 1. Check Bridge First
    const bridgeLogs = await provider.getLogs({
        address: CBBTC_BRIDGE,
        fromBlock: blockNumber,
        toBlock: blockNumber
    });

    for (const log of bridgeLogs) {
        await processBridgeEvent(blockNumber, log);
    }

    // 2. Then Watch Normal Trades
    const block = await provider.getBlockWithTransactions(blockNumber);
    const mevTxs = block.transactions.filter(tx =>
        tx.to?.toLowerCase() === AERO_CONTRACT.toLowerCase()
    );

    console.log(`block mined: ${block.transactions.length} txs, arb: ${mevTxs.length}, bridge: ${bridgeLogs.length} [${blockNumber}]`);

    for (const tx of mevTxs) {
        if (!SELECTORS.some(sel => tx.data.startsWith(sel))) continue;

        const raw = tx.data.slice(10);
        const amountIn = ethers.BigNumber.from("0x" + raw.slice(0, 64)).toString();
        const minOut = ethers.BigNumber.from("0x" + raw.slice(64, 128)).toString();
        const deadline = ethers.BigNumber.from("0x" + raw.slice(128, 192)).toString();
        const entropy = extractEntropy(tx);
        const gasDelta = getGasDelta(tx.gasLimit, block.gasUsed, block.transactions.length);
        const phiIndex = getPhiIndex(blockNumber);
        const budId = `arb_${String(budCounter).padStart(3, "0")}`;
        budCounter++;

        let signalRaw = {
            tag: budId,
            intent: tx.data.slice(0, 10),
            path: ["cbBTC", "WETH"],
            in: amountIn,
            out: minOut,
            dead: deadline,
            kws: entropy,
            gas: gasDelta,
            phi: phiIndex,
            blk: blockNumber,
            ts: block.timestamp,
            parent: lastSignalHash || "0x0"
        };

        const signalHash = hashSignal(JSON.stringify(signalRaw));
        const childHash = hashChild(signalHash, blockNumber, entropy);
        signalRaw.child = childHash;
        signalRaw.hash = signalHash;

        const signal = JSON.stringify(signalRaw);

        console.log(`arb path: ${tx.hash}, id: ${tx.data.slice(0, 10)} [${blockNumber}]`);
        try {
            await emitAndClaim(signal, blockNumber);
        } catch (err) {
            console.log(`mint failed: ${err.message} [${blockNumber}]`);
        }
    }

    // Clean old bridge requests
    for (const [block, data] of bridgeRequests) {
        if (Date.now() - data.timestamp > 600000) {
            bridgeRequests.delete(block);
        }
    }
});

// --- Claim Retry Loop ---
setInterval(async () => {
    if (retryQueue.length === 0) return;
    const baseGas = ethers.utils.parseUnits("0.001618", "gwei");

    for (let i = 0; i < retryQueue.length; i++) {
        const { signal, blockNumber } = retryQueue[i];
        try {
            const status = await tomb.getSignalStatus(signal);
            if (status.yield.eq(0)) {
                retryQueue.splice(i, 1);
                i--;
                continue;
            }

            const nonce = await provider.getTransactionCount(wallet.address, "pending");
            const claimGas = ethers.BigNumber.from("340000");

            const tx = await tomb.claimYield(signal, {
                nonce,
                gasLimit: claimGas,
                maxFeePerGas: baseGas,
                maxPriorityFeePerGas: baseGas
            });

            console.log(`debt claimed: ${tx.hash}, nonce: ${nonce} [${blockNumber}]`);
            retryQueue.splice(i, 1);
            i--;
        } catch (err) {
            if (!err.message.includes("already claimed")) {
                console.log(`retry failed: ${err.message}`);
            }
        }
    }
}, 900000);

console.log(`Monitoring started - Bridge Vector Enabled - ${new Date().toISOString()}`);
