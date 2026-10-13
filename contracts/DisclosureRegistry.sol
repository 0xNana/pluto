// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;
import {ICovenantsMarket} from "CovenantsMarket.sol";
import {RegistryAuthorization} from "RegistryAuthorization.sol";

/// @notice Immutable report attempts and authenticated, idempotent reveal callbacks.
contract DisclosureRegistry is RegistryAuthorization {
    bytes4 private constant ACK = bytes4(keccak256("onReveal(uint256,bytes)"));
    ICovenantsMarket public immutable market;
    struct Status {
        address researcher;
        bytes32 cipherHash;
        bytes32 keyCommit;
        uint64 registeredAt;
        uint64 t1;
        uint64 t2;
        bytes32 parentReportId;
        bytes32 rootReportId;
        bool disclosed;
        uint256 lastTriggerId;
        uint64 bindTime;
    }
    struct Binding { bytes32 reportId; bool bound; }
    mapping(bytes32 => Status) private reports;
    mapping(uint256 => Binding) public bindings;
    mapping(bytes32 => bool) public lineageDisclosed;
    event Registered(bytes32 indexed reportId, address indexed researcher, bytes32 cipherHash, bytes32 keyCommit, uint64 t1, uint64 t2);
    event RetryRegistered(bytes32 indexed reportId, bytes32 indexed parentReportId, bytes32 indexed rootReportId);
    event Bound(bytes32 indexed reportId, uint256 indexed triggerId);
    event Disclosed(bytes32 indexed reportId, uint256 indexed triggerId, bytes32 key);
    event Rejected(uint256 indexed triggerId, uint8 reason);
    error InvalidReport();
    error InvalidWindow();
    error DuplicateReport();
    error Unauthorized();
    error InvalidTrigger();

    constructor(address market_) {
        if (market_.code.length == 0) revert InvalidTrigger();
        market = ICovenantsMarket(market_);
    }

    function register(bytes32 cipherHash, bytes32 keyCommit, uint64 t1, uint64 t2) external returns (bytes32 reportId) {
        return _register(msg.sender, cipherHash, keyCommit, t1, t2);
    }

    function registerBySig(bytes32 cipherHash, bytes32 keyCommit, uint64 t1, uint64 t2, Authorization calldata auth) external returns (bytes32) {
        _consumeAuthorization(keccak256(abi.encode(REGISTER_TYPEHASH, cipherHash, keyCommit, t1, t2,
            auth.researcher, auth.payer, auth.nonce, auth.deadline)), auth);
        return _register(auth.researcher, cipherHash, keyCommit, t1, t2);
    }

    function _register(address author, bytes32 cipherHash, bytes32 keyCommit, uint64 t1, uint64 t2) internal returns (bytes32 reportId) {
        reportId = keccak256(abi.encode(author, cipherHash, keyCommit));
        _store(reportId, author, cipherHash, keyCommit, t1, t2, bytes32(0), reportId);
    }

    function registerRetry(bytes32 parentReportId, uint64 t1, uint64 t2) external returns (bytes32 reportId) {
        return _registerRetry(msg.sender, parentReportId, t1, t2);
    }

    function retryBySig(bytes32 parentReportId, uint64 t1, uint64 t2, Authorization calldata auth) external returns (bytes32) {
        _consumeAuthorization(keccak256(abi.encode(RETRY_TYPEHASH, parentReportId, t1, t2,
            auth.researcher, auth.payer, auth.nonce, auth.deadline)), auth);
        return _registerRetry(auth.researcher, parentReportId, t1, t2);
    }

    function _registerRetry(address author, bytes32 parentReportId, uint64 t1, uint64 t2) internal returns (bytes32 reportId) {
        Status storage parent = reports[parentReportId];
        if (parent.researcher == address(0)) revert InvalidReport();
        if (parent.researcher != author) revert Unauthorized();
        if (block.timestamp <= parent.t2 || lineageDisclosed[parent.rootReportId]) revert InvalidWindow();
        reportId = keccak256(abi.encode(parentReportId, t1, t2));
        _store(reportId, author, parent.cipherHash, parent.keyCommit, t1, t2, parentReportId, parent.rootReportId);
        emit RetryRegistered(reportId, parentReportId, parent.rootReportId);
    }

    function _store(bytes32 id, address author, bytes32 cipherHash, bytes32 keyCommit, uint64 t1, uint64 t2, bytes32 parent, bytes32 root) private {
        if (reports[id].researcher != address(0)) revert DuplicateReport();
        if (t1 <= block.timestamp || t2 <= t1) revert InvalidWindow();
        reports[id] = Status(author, cipherHash, keyCommit, uint64(block.timestamp), t1, t2, parent, root, false, 0, 0);
        emit Registered(id, author, cipherHash, keyCommit, t1, t2);
    }

    function bindTrigger(bytes32 reportId, uint256 triggerId) external {
        _bind(msg.sender, reportId, triggerId);
    }

    function bindBySig(bytes32 reportId, uint256 triggerId, Authorization calldata auth) external {
        _consumeAuthorization(keccak256(abi.encode(BIND_TYPEHASH, reportId, triggerId,
            auth.researcher, auth.payer, auth.nonce, auth.deadline)), auth);
        _bind(auth.researcher, reportId, triggerId);
    }

    function _bind(address author, bytes32 reportId, uint256 triggerId) internal {
        Status storage report = reports[reportId];
        if (report.researcher == address(0)) revert InvalidReport();
        if (report.researcher != author) revert Unauthorized();
        if (block.timestamp >= report.t1 || lineageDisclosed[report.rootReportId]) revert InvalidWindow();
        if (bindings[triggerId].bound) revert InvalidTrigger();
        (address triggerAuthor,) = market.postingParties(triggerId);
        (address hook,,,,,) = market.hookMeta(triggerId);
        (uint8 mode,,, uint64 expiry, uint64 t1, uint64 t2,,, bool resolved,,,) = market.triggerMeta(triggerId);
        if (triggerAuthor != author || hook != address(this) || mode != 1 || resolved ||
            t1 != report.t1 || t2 != report.t2 || expiry != report.t2) revert InvalidTrigger();
        bindings[triggerId] = Binding(reportId, true);
        report.lastTriggerId = triggerId;
        report.bindTime = uint64(block.timestamp);
        emit Bound(reportId, triggerId);
    }

    function statusOf(bytes32 reportId) external view returns (Status memory) {
        return reports[reportId];
    }

    function onReveal(uint256 triggerId, bytes calldata plaintext) external returns (bytes4) {
        if (msg.sender != address(market)) return bytes4(0);
        Binding memory binding = bindings[triggerId];
        if (!binding.bound) return _reject(triggerId, 1);
        Status storage report = reports[binding.reportId];
        if (lineageDisclosed[report.rootReportId]) return _reject(triggerId, 2);
        if (plaintext.length != 96) return _reject(triggerId, 3);
        bytes32 key = bytes32(plaintext[0:32]);
        if (bytes32(plaintext[32:64]) != binding.reportId) return _reject(triggerId, 4);
        if (keccak256(abi.encodePacked(key)) != report.keyCommit) return _reject(triggerId, 5);
        // Bound the external view and validate its encoding without a reverting ABI decoder.
        (bool ok, bytes memory parties) = address(market).staticcall{gas: 40000}(
            abi.encodeWithSelector(ICovenantsMarket.postingParties.selector, triggerId));
        if (!ok || parties.length != 64) {
            emit Rejected(triggerId, 7);
            return bytes4(0); // A transient market read failure can be retried.
        }
        uint256 authorWord;
        assembly { authorWord := mload(add(parties, 32)) }
        if (authorWord != uint256(uint160(report.researcher))) return _reject(triggerId, 6);
        report.disclosed = true;
        lineageDisclosed[report.rootReportId] = true;
        emit Disclosed(binding.reportId, triggerId, key);
        return ACK;
    }

    function _reject(uint256 triggerId, uint8 reason) private returns (bytes4) {
        emit Rejected(triggerId, reason);
        return ACK;
    }
}
