from http import HTTPStatus
from typing import Any, cast

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.claim_embed_link_body import ClaimEmbedLinkBody
from ...models.embed_signer import EmbedSigner
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: ClaimEmbedLinkBody,
    keelson_embed: str | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}
    if not isinstance(keelson_embed, Unset):
        headers["keelson-embed"] = keelson_embed

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/embed/links/claim",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> EmbedSigner | None | Problem | None:
    if response.status_code == 200:

        def _parse_response_200(data: object) -> EmbedSigner | None:
            if data is None:
                return data
            try:
                if not isinstance(data, dict):
                    raise TypeError()
                response_200_type_0 = EmbedSigner.from_dict(data)

                return response_200_type_0
            except (TypeError, ValueError, AttributeError, KeyError):
                pass
            return cast(EmbedSigner | None, data)

        response_200 = _parse_response_200(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[EmbedSigner | None | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ClaimEmbedLinkBody,
    keelson_embed: str | Unset = UNSET,
) -> Response[EmbedSigner | None | Problem]:
    """Claim a link's grant in the embedded approval

     The frame redeems the grant its Keelson window handed it. It works once, and only for the session
    that opened the link; the session then signs for that user.

    Args:
        keelson_embed (str | Unset):
        body (ClaimEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedSigner | None | Problem]
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
    body: ClaimEmbedLinkBody,
    keelson_embed: str | Unset = UNSET,
) -> EmbedSigner | None | Problem | None:
    """Claim a link's grant in the embedded approval

     The frame redeems the grant its Keelson window handed it. It works once, and only for the session
    that opened the link; the session then signs for that user.

    Args:
        keelson_embed (str | Unset):
        body (ClaimEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedSigner | None | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
        keelson_embed=keelson_embed,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: ClaimEmbedLinkBody,
    keelson_embed: str | Unset = UNSET,
) -> Response[EmbedSigner | None | Problem]:
    """Claim a link's grant in the embedded approval

     The frame redeems the grant its Keelson window handed it. It works once, and only for the session
    that opened the link; the session then signs for that user.

    Args:
        keelson_embed (str | Unset):
        body (ClaimEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[EmbedSigner | None | Problem]
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
    body: ClaimEmbedLinkBody,
    keelson_embed: str | Unset = UNSET,
) -> EmbedSigner | None | Problem | None:
    """Claim a link's grant in the embedded approval

     The frame redeems the grant its Keelson window handed it. It works once, and only for the session
    that opened the link; the session then signs for that user.

    Args:
        keelson_embed (str | Unset):
        body (ClaimEmbedLinkBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        EmbedSigner | None | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
            keelson_embed=keelson_embed,
        )
    ).parsed
