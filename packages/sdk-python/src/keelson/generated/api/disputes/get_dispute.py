from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.dispute_status import DisputeStatus
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    id: str,
) -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/disputes/{id}".format(
            id=quote(str(id), safe=""),
        ),
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> DisputeStatus | Problem | None:
    if response.status_code == 200:
        response_200 = DisputeStatus.from_dict(response.json())

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
) -> Response[DisputeStatus | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[DisputeStatus | Problem]:
    """A dispute's attribution

     Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE
    legs signed, the time from the dispute's arrival to its verdict, and the operator's amber commitment
    with any conviction of it. No authentication; it holds no personal data, so what the operator
    attested is left out.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DisputeStatus | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: AuthenticatedClient | Client,
) -> DisputeStatus | Problem | None:
    """A dispute's attribution

     Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE
    legs signed, the time from the dispute's arrival to its verdict, and the operator's amber commitment
    with any conviction of it. No authentication; it holds no personal data, so what the operator
    attested is left out.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DisputeStatus | Problem
    """

    return sync_detailed(
        id=id,
        client=client,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient | Client,
) -> Response[DisputeStatus | Problem]:
    """A dispute's attribution

     Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE
    legs signed, the time from the dispute's arrival to its verdict, and the operator's amber commitment
    with any conviction of it. No authentication; it holds no personal data, so what the operator
    attested is left out.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[DisputeStatus | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: AuthenticatedClient | Client,
) -> DisputeStatus | Problem | None:
    """A dispute's attribution

     Where a PayPal dispute over a Keelson purchase stands: the party at fault, the `Verdict` both TEE
    legs signed, the time from the dispute's arrival to its verdict, and the operator's amber commitment
    with any conviction of it. No authentication; it holds no personal data, so what the operator
    attested is left out.

    Args:
        id (str):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        DisputeStatus | Problem
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
        )
    ).parsed
