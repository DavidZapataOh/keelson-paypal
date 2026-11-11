from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.evidence_manifest import EvidenceManifest
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    root: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/evidence/{root}".format(
            root=quote(str(root), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> EvidenceManifest | Problem | None:
    if response.status_code == 200:
        response_200 = EvidenceManifest.from_dict(response.json())

        return response_200

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[EvidenceManifest | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    root: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[EvidenceManifest | Problem]:
    """Read an evidence manifest

     The public manifest of a stored bundle: salted leaves only.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EvidenceManifest | Problem]
    """

    kwargs = _get_kwargs(
        root=root,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    root: str,
    *,
    client: AuthenticatedClient | Client,
) -> EvidenceManifest | Problem | None:
    """Read an evidence manifest

     The public manifest of a stored bundle: salted leaves only.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EvidenceManifest | Problem
    """

    return sync_detailed(
        root=root,
        client=client,
    ).parsed


async def asyncio_detailed(
    root: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[EvidenceManifest | Problem]:
    """Read an evidence manifest

     The public manifest of a stored bundle: salted leaves only.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EvidenceManifest | Problem]
    """

    kwargs = _get_kwargs(
        root=root,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    root: str,
    *,
    client: AuthenticatedClient | Client,
) -> EvidenceManifest | Problem | None:
    """Read an evidence manifest

     The public manifest of a stored bundle: salted leaves only.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EvidenceManifest | Problem
    """

    return (
        await asyncio_detailed(
            root=root,
            client=client,
        )
    ).parsed
