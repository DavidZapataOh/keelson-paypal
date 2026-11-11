from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.disclose_evidence_item_decrypt import (
    DiscloseEvidenceItemDecrypt,
)
from ...models.disclosed_evidence import DisclosedEvidence
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    root: str,
    index: int,
    *,
    reason: str,
    decrypt: DiscloseEvidenceItemDecrypt | Unset = UNSET,
) -> dict[str, Any]:

    params: dict[str, Any] = {}

    params["reason"] = reason

    json_decrypt: str | Unset = UNSET
    if not isinstance(decrypt, Unset):
        json_decrypt = decrypt

    params["decrypt"] = json_decrypt

    params = {k: v for k, v in params.items() if v is not UNSET and v is not None}

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/evidence/{root}/items/{index}".format(
            root=quote(str(root), safe=""),
            index=quote(str(index), safe=""),
        ),
        "params": params,
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> DisclosedEvidence | Problem | None:
    if response.status_code == 200:
        response_200 = DisclosedEvidence.from_dict(response.json())

        return response_200

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[DisclosedEvidence | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    root: str,
    index: int,
    *,
    client: AuthenticatedClient,
    reason: str,
    decrypt: DiscloseEvidenceItemDecrypt | Unset = UNSET,
) -> Response[DisclosedEvidence | Problem]:
    """Disclose one evidence item

     One item with its content hash, salt and inclusion proof, for an arbiter. Every disclosure is
    recorded with its `reason`. An `.original` item stays age ciphertext unless `decrypt=1` is sent with
    the `evidence:decrypt` scope.

    Args:
        root (str):
        index (int):
        reason (str): Why the item is opened, such as the dispute it serves.
        decrypt (DiscloseEvidenceItemDecrypt | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DisclosedEvidence | Problem]
    """

    kwargs = _get_kwargs(
        root=root,
        index=index,
        reason=reason,
        decrypt=decrypt,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    root: str,
    index: int,
    *,
    client: AuthenticatedClient,
    reason: str,
    decrypt: DiscloseEvidenceItemDecrypt | Unset = UNSET,
) -> DisclosedEvidence | Problem | None:
    """Disclose one evidence item

     One item with its content hash, salt and inclusion proof, for an arbiter. Every disclosure is
    recorded with its `reason`. An `.original` item stays age ciphertext unless `decrypt=1` is sent with
    the `evidence:decrypt` scope.

    Args:
        root (str):
        index (int):
        reason (str): Why the item is opened, such as the dispute it serves.
        decrypt (DiscloseEvidenceItemDecrypt | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DisclosedEvidence | Problem
    """

    return sync_detailed(
        root=root,
        index=index,
        client=client,
        reason=reason,
        decrypt=decrypt,
    ).parsed


async def asyncio_detailed(
    root: str,
    index: int,
    *,
    client: AuthenticatedClient,
    reason: str,
    decrypt: DiscloseEvidenceItemDecrypt | Unset = UNSET,
) -> Response[DisclosedEvidence | Problem]:
    """Disclose one evidence item

     One item with its content hash, salt and inclusion proof, for an arbiter. Every disclosure is
    recorded with its `reason`. An `.original` item stays age ciphertext unless `decrypt=1` is sent with
    the `evidence:decrypt` scope.

    Args:
        root (str):
        index (int):
        reason (str): Why the item is opened, such as the dispute it serves.
        decrypt (DiscloseEvidenceItemDecrypt | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DisclosedEvidence | Problem]
    """

    kwargs = _get_kwargs(
        root=root,
        index=index,
        reason=reason,
        decrypt=decrypt,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    root: str,
    index: int,
    *,
    client: AuthenticatedClient,
    reason: str,
    decrypt: DiscloseEvidenceItemDecrypt | Unset = UNSET,
) -> DisclosedEvidence | Problem | None:
    """Disclose one evidence item

     One item with its content hash, salt and inclusion proof, for an arbiter. Every disclosure is
    recorded with its `reason`. An `.original` item stays age ciphertext unless `decrypt=1` is sent with
    the `evidence:decrypt` scope.

    Args:
        root (str):
        index (int):
        reason (str): Why the item is opened, such as the dispute it serves.
        decrypt (DiscloseEvidenceItemDecrypt | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DisclosedEvidence | Problem
    """

    return (
        await asyncio_detailed(
            root=root,
            index=index,
            client=client,
            reason=reason,
            decrypt=decrypt,
        )
    ).parsed
