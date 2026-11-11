from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.connection_draft import ConnectionDraft
from ...models.draft_embed_mandate_response_200 import DraftEmbedMandateResponse200
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: ConnectionDraft,
    keelson_embed: str | Unset = UNSET,
    keelson_device: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_embed, Unset):
        headers["keelson-embed"] = keelson_embed

    if not isinstance(keelson_device, Unset):
        headers["keelson-device"] = keelson_device

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/embed/draft",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> DraftEmbedMandateResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = DraftEmbedMandateResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

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
) -> Response[DraftEmbedMandateResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ConnectionDraft,
    keelson_embed: str | Unset = UNSET,
    keelson_device: str | Unset = UNSET,
) -> Response[DraftEmbedMandateResponse200 | Problem]:
    """Draft the mandate in the embedded approval

     As `POST /v1/connections/{code}/draft`, for the embedded request and the session's user. The mandate
    carries `embed.top_origin`, the platform's origin, so only an assertion made in this frame signs it.

    Args:
        keelson_embed (str | Unset):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DraftEmbedMandateResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_embed=keelson_embed,
        keelson_device=keelson_device,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: ConnectionDraft,
    keelson_embed: str | Unset = UNSET,
    keelson_device: str | Unset = UNSET,
) -> DraftEmbedMandateResponse200 | Problem | None:
    """Draft the mandate in the embedded approval

     As `POST /v1/connections/{code}/draft`, for the embedded request and the session's user. The mandate
    carries `embed.top_origin`, the platform's origin, so only an assertion made in this frame signs it.

    Args:
        keelson_embed (str | Unset):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DraftEmbedMandateResponse200 | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
        keelson_embed=keelson_embed,
        keelson_device=keelson_device,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ConnectionDraft,
    keelson_embed: str | Unset = UNSET,
    keelson_device: str | Unset = UNSET,
) -> Response[DraftEmbedMandateResponse200 | Problem]:
    """Draft the mandate in the embedded approval

     As `POST /v1/connections/{code}/draft`, for the embedded request and the session's user. The mandate
    carries `embed.top_origin`, the platform's origin, so only an assertion made in this frame signs it.

    Args:
        keelson_embed (str | Unset):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DraftEmbedMandateResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_embed=keelson_embed,
        keelson_device=keelson_device,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: ConnectionDraft,
    keelson_embed: str | Unset = UNSET,
    keelson_device: str | Unset = UNSET,
) -> DraftEmbedMandateResponse200 | Problem | None:
    """Draft the mandate in the embedded approval

     As `POST /v1/connections/{code}/draft`, for the embedded request and the session's user. The mandate
    carries `embed.top_origin`, the platform's origin, so only an assertion made in this frame signs it.

    Args:
        keelson_embed (str | Unset):
        keelson_device (str | Unset):
        body (ConnectionDraft):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DraftEmbedMandateResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            keelson_embed=keelson_embed,
            keelson_device=keelson_device,
        )
    ).parsed
