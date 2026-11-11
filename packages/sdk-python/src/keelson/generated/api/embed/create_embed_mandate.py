from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.create_embed_mandate_body import CreateEmbedMandateBody
from ...models.created_mandate import CreatedMandate
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: CreateEmbedMandateBody,
    keelson_embed: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_embed, Unset):
        headers["keelson-embed"] = keelson_embed

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/embed/mandates",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> CreatedMandate | Problem | None:
    if response.status_code == 201:
        response_201 = CreatedMandate.from_dict(response.json())

        return response_201

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

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if response.status_code == 503:
        response_503 = Problem.from_dict(response.json())

        return response_503

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[CreatedMandate | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateEmbedMandateBody,
    keelson_embed: str | Unset = UNSET,
) -> Response[CreatedMandate | Problem]:
    """Approve the embedded request with a signed mandate

     As `POST /v1/mandates` with `connection`, for the embedded request and the session's user. The
    mandate's `embed.top_origin` must be the platform's origin, still registered, and the assertion must
    be made in this frame under it.

    Args:
        keelson_embed (str | Unset):
        body (CreateEmbedMandateBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreatedMandate | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_embed=keelson_embed,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: CreateEmbedMandateBody,
    keelson_embed: str | Unset = UNSET,
) -> CreatedMandate | Problem | None:
    """Approve the embedded request with a signed mandate

     As `POST /v1/mandates` with `connection`, for the embedded request and the session's user. The
    mandate's `embed.top_origin` must be the platform's origin, still registered, and the assertion must
    be made in this frame under it.

    Args:
        keelson_embed (str | Unset):
        body (CreateEmbedMandateBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreatedMandate | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
        keelson_embed=keelson_embed,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: CreateEmbedMandateBody,
    keelson_embed: str | Unset = UNSET,
) -> Response[CreatedMandate | Problem]:
    """Approve the embedded request with a signed mandate

     As `POST /v1/mandates` with `connection`, for the embedded request and the session's user. The
    mandate's `embed.top_origin` must be the platform's origin, still registered, and the assertion must
    be made in this frame under it.

    Args:
        keelson_embed (str | Unset):
        body (CreateEmbedMandateBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CreatedMandate | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
        keelson_embed=keelson_embed,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: CreateEmbedMandateBody,
    keelson_embed: str | Unset = UNSET,
) -> CreatedMandate | Problem | None:
    """Approve the embedded request with a signed mandate

     As `POST /v1/mandates` with `connection`, for the embedded request and the session's user. The
    mandate's `embed.top_origin` must be the platform's origin, still registered, and the assertion must
    be made in this frame under it.

    Args:
        keelson_embed (str | Unset):
        body (CreateEmbedMandateBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CreatedMandate | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            keelson_embed=keelson_embed,
        )
    ).parsed
