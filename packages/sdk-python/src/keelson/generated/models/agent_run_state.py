from typing import Literal

AgentRunState = Literal["ended", "started"]

AGENT_RUN_STATE_VALUES: set[AgentRunState] = {
    "ended",
    "started",
}


def check_agent_run_state(value: str) -> AgentRunState:
    if value in AGENT_RUN_STATE_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {AGENT_RUN_STATE_VALUES!r}")
