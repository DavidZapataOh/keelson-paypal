# Surviving mutants

Every mutant that survives the nightly `forge test --mutate` run is listed here with the reason it is equivalent to the original code.

Only mutants that behave like the original on every reachable input are listed, each with its proof; every other survivor is killed by a test.

## KeelsonValidationRegistry

- `src/KeelsonValidationRegistry.sol:83:13 s.validatorAddress != address(0) -> s.validatorAddress > address(0)`: an address is unsigned, so `a != address(0)` ⇔ `a > address(0)`.
- `src/KeelsonValidationRegistry.sol:84:29 c.decision != DENY -> c.decision < DENY`: a recorded validation's decision is ALLOW (1) or DENY (2); 1 < 2 and 1 != 2 are both true, 2 < 2 and 2 != 2 both false.
- `src/KeelsonValidationRegistry.sol:84:51 keccak256(bytes(s.tag)) != keccak256("degraded") -> keccak256(bytes(s.tag)) < keccak256("degraded")`: the stored tag is one of `degraded`, `2of2`, `settled`, `slashed`; the hashes of the last three (0x4e8c…, 0xb813…, 0xaab1…) are all below keccak256("degraded") (0xdab8…), so `!=` and `<` agree on every reachable tag.
- `src/KeelsonValidationRegistry.sol:95:17 cov.status == IKeelsonBondVault.Status.None -> cov.status <= IKeelsonBondVault.Status.None`: `None` is the enum's 0, so `status == None` ⇔ `status <= None`.
- `src/KeelsonValidationRegistry.sol:99:17 requestOf[c.requestId] != 0 -> requestOf[c.requestId] > 0`: bytes32 compares unsigned, so `x != 0` ⇔ `x > 0`.
- `src/KeelsonValidationRegistry.sol:133:17 outcome != CoverageOutcome.Outcome.Open -> outcome > CoverageOutcome.Outcome.Open`: `Open` is the enum's 0, so `outcome != Open` ⇔ `outcome > Open`.
- `src/KeelsonValidationRegistry.sol:140:13 requestHash == 0 -> requestHash <= 0`: bytes32 compares unsigned, so `x == 0` ⇔ `x <= 0`.
- `src/KeelsonValidationRegistry.sol:143:13 outcome == CoverageOutcome.Outcome.Open -> outcome <= CoverageOutcome.Outcome.Open`: `Open` is the enum's 0, so `outcome == Open` ⇔ `outcome <= Open`.
- `src/KeelsonValidationRegistry.sol:166:13 s.validatorAddress == address(0) -> s.validatorAddress <= address(0)`: an address is unsigned, so `a == address(0)` ⇔ `a <= address(0)`.
- `src/KeelsonValidationRegistry.sol:180:25 i < requestHashes.length -> i != requestHashes.length`: i starts at 0 and grows by 1, so it reaches the length exactly: `i < length` ⇔ `i != length`.
- `src/KeelsonValidationRegistry.sol:180:51 ++i -> i++`: the loop's increment expression discards its value, so `++i` and `i++` are the same.
- `src/KeelsonValidationRegistry.sol:182:35 validatorAddresses.length == 0 -> validatorAddresses.length <= 0`: a length is unsigned, so `length == 0` ⇔ `length <= 0`.
- `src/KeelsonValidationRegistry.sol:183:52 j < validatorAddresses.length -> j != validatorAddresses.length`: j starts at 0 and grows by 1, so it reaches the length exactly: `j < length` ⇔ `j != length`.
- `src/KeelsonValidationRegistry.sol:183:83 ++j -> j++`: the loop's increment expression discards its value, so `++j` and `j++` are the same.
- `src/KeelsonValidationRegistry.sol:186:36 bytes(tag).length == 0 -> bytes(tag).length <= 0`: a length is unsigned, so `length == 0` ⇔ `length <= 0`.
- `src/KeelsonValidationRegistry.sol:188:17 ++count -> count++`: the statement discards the expression's value, so `++count` and `count++` are the same.
- `src/KeelsonValidationRegistry.sol:192:23 count > 0 -> count != 0`: count is unsigned, so `count > 0` ⇔ `count != 0`.
- `src/KeelsonValidationRegistry.sol:238:16 wallet != address(0) -> wallet > address(0)`: an address is unsigned, so `a != address(0)` ⇔ `a > address(0)`.
- `src/KeelsonValidationRegistry.sol:238:16 wallet != address(0) -> wallet >= address(0)`: `wallet >= address(0)` is always true, and when `wallet` is the zero address `SignatureChecker.isValidSignatureNowCalldata(address(0), …)` is false (no ECDSA signature recovers to it, and it has no code for ERC-1271), so the conjunction is unchanged.
