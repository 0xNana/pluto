// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice EOA author grants for gas-paid registry actions, scoped to this chain and contract.
abstract contract RegistryAuthorization {
    struct Authorization {
        address researcher;
        address payer;
        uint256 nonce;
        uint64 deadline;
        bytes signature;
    }
    mapping(address => mapping(uint256 => bool)) public authorizationUsed;
    event AuthorizationConsumed(address indexed researcher, address indexed payer, uint256 nonce);
    error InvalidAuthorization();

    bytes32 internal constant REGISTER_TYPEHASH = keccak256(
        "RegisterReport(bytes32 cipherHash,bytes32 keyCommit,uint64 t1,uint64 t2,address researcher,address payer,uint256 nonce,uint64 deadline)");
    bytes32 internal constant BIND_TYPEHASH = keccak256(
        "BindReport(bytes32 reportId,uint256 triggerId,address researcher,address payer,uint256 nonce,uint64 deadline)");
    bytes32 internal constant RETRY_TYPEHASH = keccak256(
        "RetryReport(bytes32 parentReportId,uint64 t1,uint64 t2,address researcher,address payer,uint256 nonce,uint64 deadline)");

    function _consumeAuthorization(bytes32 structHash, Authorization calldata auth) internal {
        if (auth.researcher == address(0) || auth.payer != msg.sender ||
            block.timestamp > auth.deadline || authorizationUsed[auth.researcher][auth.nonce] ||
            auth.signature.length != 65) revert InvalidAuthorization();
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Pluto Registry"), keccak256("1"), block.chainid, address(this)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        bytes calldata signature = auth.signature;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Canonical secp256k1 signatures only; ecrecover otherwise permits high-s malleability.
        if ((v != 27 && v != 28) || uint256(s) >
            0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0 ||
            ecrecover(digest, v, r, s) != auth.researcher) revert InvalidAuthorization();
        authorizationUsed[auth.researcher][auth.nonce] = true;
        emit AuthorizationConsumed(auth.researcher, auth.payer, auth.nonce);
    }
}
