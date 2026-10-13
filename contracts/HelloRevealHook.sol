// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice M0 probe only. This accepts any market-authenticated, 64-byte payload.
/// It is not the Pluto report registry and must not receive real reports.
contract HelloRevealHook {
    bytes4 private constant ACK = bytes4(keccak256("onReveal(uint256,bytes)"));
    address public immutable market;
    mapping(uint256 => bool) public accepted;
    event HelloRevealed(uint256 indexed triggerId, bytes32 key, bytes32 reportId);
    event HelloRejected(uint256 indexed triggerId);

    constructor(address market_) {
        require(market_ != address(0), "zero market");
        market = market_;
    }

    function onReveal(uint256 triggerId, bytes calldata plaintext) external returns (bytes4) {
        if (msg.sender != market) return bytes4(0);
        if (accepted[triggerId]) return ACK;
        if (plaintext.length != 96) {
            emit HelloRejected(triggerId);
            return ACK;
        }
        // The last 32 bytes are the SDK nonce, not application payload.
        bytes32 key = bytes32(plaintext[0:32]);
        bytes32 reportId = bytes32(plaintext[32:64]);
        accepted[triggerId] = true;
        emit HelloRevealed(triggerId, key, reportId);
        return ACK;
    }
}
