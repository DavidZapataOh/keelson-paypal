from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.anonymous_mandate import AnonymousMandate
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    mandate_hash: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/anonymous-mandates/{mandate_hash}".format(
            mandate_hash=quote(str(mandate_hash), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> AnonymousMandate | Problem | None:
    if response.status_code == 200:
        response_200 = AnonymousMandate.from_dict(response.json())

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
) -> Response[AnonymousMandate | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    mandate_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[AnonymousMandate | Problem]:
    """Proof that a registered user signed a mandate

     The C3 `anonymous_mandate` zero-knowledge proof of the mandate whose passkey challenge is
    `mandateHash`, the `mandateHash` of its countersigns: a passkey in Keelson's registered-user tree
    signed it, and the mandate's commitment names that passkey. It shows neither the user nor the key,
    so it needs no authentication. Verify it with bb.js against the C3 key or with `eth_call` on
    `verifier`, and check that `user_set_root` is published in the `RegisteredUserSet` contract, as
    `verifyAnonymousMandate` in `@keelson/alibi/verify` does.

    Args:
        mandate_hash (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AnonymousMandate | Problem]
    """

    kwargs = _get_kwargs(
        mandate_hash=mandate_hash,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    mandate_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> AnonymousMandate | Problem | None:
    """Proof that a registered user signed a mandate

     The C3 `anonymous_mandate` zero-knowledge proof of the mandate whose passkey challenge is
    `mandateHash`, the `mandateHash` of its countersigns: a passkey in Keelson's registered-user tree
    signed it, and the mandate's commitment names that passkey. It shows neither the user nor the key,
    so it needs no authentication. Verify it with bb.js against the C3 key or with `eth_call` on
    `verifier`, and check that `user_set_root` is published in the `RegisteredUserSet` contract, as
    `verifyAnonymousMandate` in `@keelson/alibi/verify` does.

    Args:
        mandate_hash (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AnonymousMandate | Problem
    """

    return sync_detailed(
        mandate_hash=mandate_hash,
        client=client,
    ).parsed


async def asyncio_detailed(
    mandate_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[AnonymousMandate | Problem]:
    """Proof that a registered user signed a mandate

     The C3 `anonymous_mandate` zero-knowledge proof of the mandate whose passkey challenge is
    `mandateHash`, the `mandateHash` of its countersigns: a passkey in Keelson's registered-user tree
    signed it, and the mandate's commitment names that passkey. It shows neither the user nor the key,
    so it needs no authentication. Verify it with bb.js against the C3 key or with `eth_call` on
    `verifier`, and check that `user_set_root` is published in the `RegisteredUserSet` contract, as
    `verifyAnonymousMandate` in `@keelson/alibi/verify` does.

    Args:
        mandate_hash (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[AnonymousMandate | Problem]
    """

    kwargs = _get_kwargs(
        mandate_hash=mandate_hash,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    mandate_hash: str,
    *,
    client: AuthenticatedClient | Client,
) -> AnonymousMandate | Problem | None:
    """Proof that a registered user signed a mandate

     The C3 `anonymous_mandate` zero-knowledge proof of the mandate whose passkey challenge is
    `mandateHash`, the `mandateHash` of its countersigns: a passkey in Keelson's registered-user tree
    signed it, and the mandate's commitment names that passkey. It shows neither the user nor the key,
    so it needs no authentication. Verify it with bb.js against the C3 key or with `eth_call` on
    `verifier`, and check that `user_set_root` is published in the `RegisteredUserSet` contract, as
    `verifyAnonymousMandate` in `@keelson/alibi/verify` does.

    Args:
        mandate_hash (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        AnonymousMandate | Problem
    """

    return (
        await asyncio_detailed(
            mandate_hash=mandate_hash,
            client=client,
        )
    ).parsed
