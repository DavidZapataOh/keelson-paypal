//! The `stacker` API Cedar calls, for a workspace that runs it in the SP1 zkVM: the zkVM has no
//! operating system to read a stack limit from or map a new stack with. Cedar treats an unknown
//! remaining stack as enough, so the evaluation is the same; a stack that runs out fails the
//! execution, which then has no proof.

/// The stack left, which the zkVM cannot tell.
pub fn remaining_stack() -> Option<usize> {
    None
}

/// Runs `callback` on the current stack.
pub fn maybe_grow<R, F: FnOnce() -> R>(_red_zone: usize, _stack_size: usize, callback: F) -> R {
    callback()
}

/// Runs `callback` on the current stack.
pub fn grow<R, F: FnOnce() -> R>(_stack_size: usize, callback: F) -> R {
    callback()
}
