from typing import Literal

EvidenceManifestV = Literal["keelson.manifest/1"]

EVIDENCE_MANIFEST_V_VALUES: set[EvidenceManifestV] = {
    "keelson.manifest/1",
}


def check_evidence_manifest_v(value: str) -> EvidenceManifestV:
    if value in EVIDENCE_MANIFEST_V_VALUES:
        return value
    raise TypeError(f"Unexpected value {value!r}. Expected one of {EVIDENCE_MANIFEST_V_VALUES!r}")
