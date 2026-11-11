from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.problem import Problem
from ...models.user_set_root import UserSetRoot
from ...types import Response


def _get_kwargs(
    root: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/user-set/roots/{root}".format(
            root=quote(str(root), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | UserSetRoot | None:
    if response.status_code == 200:
        response_200 = UserSetRoot.from_dict(response.json())

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
) -> Response[Problem | UserSetRoot]:
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
) -> Response[Problem | UserSetRoot]:
    """A root of the registered-user tree

     Whether `root` is, or was, the root of Keelson's registered-user tree: the Poseidon2 Merkle tree of
    every registered passkey's `user_key_hash`. A C3 proof under any root listed here was made by a
    registered user, who is hidden among the `size` users of that root. Roots stay valid after a passkey
    is removed. Keelson's relayer publishes every root to the `RegisteredUserSet` contract, which is
    what a verifier trusts; this route is a convenience.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | UserSetRoot]
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
) -> Problem | UserSetRoot | None:
    """A root of the registered-user tree

     Whether `root` is, or was, the root of Keelson's registered-user tree: the Poseidon2 Merkle tree of
    every registered passkey's `user_key_hash`. A C3 proof under any root listed here was made by a
    registered user, who is hidden among the `size` users of that root. Roots stay valid after a passkey
    is removed. Keelson's relayer publishes every root to the `RegisteredUserSet` contract, which is
    what a verifier trusts; this route is a convenience.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | UserSetRoot
    """

    return sync_detailed(
        root=root,
        client=client,
    ).parsed


async def asyncio_detailed(
    root: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[Problem | UserSetRoot]:
    """A root of the registered-user tree

     Whether `root` is, or was, the root of Keelson's registered-user tree: the Poseidon2 Merkle tree of
    every registered passkey's `user_key_hash`. A C3 proof under any root listed here was made by a
    registered user, who is hidden among the `size` users of that root. Roots stay valid after a passkey
    is removed. Keelson's relayer publishes every root to the `RegisteredUserSet` contract, which is
    what a verifier trusts; this route is a convenience.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | UserSetRoot]
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
) -> Problem | UserSetRoot | None:
    """A root of the registered-user tree

     Whether `root` is, or was, the root of Keelson's registered-user tree: the Poseidon2 Merkle tree of
    every registered passkey's `user_key_hash`. A C3 proof under any root listed here was made by a
    registered user, who is hidden among the `size` users of that root. Roots stay valid after a passkey
    is removed. Keelson's relayer publishes every root to the `RegisteredUserSet` contract, which is
    what a verifier trusts; this route is a convenience.

    Args:
        root (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | UserSetRoot
    """

    return (
        await asyncio_detailed(
            root=root,
            client=client,
        )
    ).parsed
