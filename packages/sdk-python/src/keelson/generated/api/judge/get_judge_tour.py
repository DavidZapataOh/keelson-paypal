from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.judge_tour import JudgeTour
from ...models.problem import Problem
from ...types import Response


def _get_kwargs() -> dict[str, Any]:

    _kwargs: dict[str, Any] = {
        "method": "get",
        "url": "/v1/judge/tour",
    }

    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> JudgeTour | Problem | None:
    if response.status_code == 200:
        response_200 = JudgeTour.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[JudgeTour | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[JudgeTour | Problem]:
    """What the Judge Mode tour shows

     The newest real records on this deployment: the demo operator's latest mandate with a captured
    purchase (its card and every purchase under it, blocked ones included), the latest sandbox dispute
    with a verdict, and the latest finished red-team campaign. Judges only.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[JudgeTour | Problem]
    """

    kwargs = _get_kwargs()

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
) -> JudgeTour | Problem | None:
    """What the Judge Mode tour shows

     The newest real records on this deployment: the demo operator's latest mandate with a captured
    purchase (its card and every purchase under it, blocked ones included), the latest sandbox dispute
    with a verdict, and the latest finished red-team campaign. Judges only.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        JudgeTour | Problem
    """

    return sync_detailed(
        client=client,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
) -> Response[JudgeTour | Problem]:
    """What the Judge Mode tour shows

     The newest real records on this deployment: the demo operator's latest mandate with a captured
    purchase (its card and every purchase under it, blocked ones included), the latest sandbox dispute
    with a verdict, and the latest finished red-team campaign. Judges only.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[JudgeTour | Problem]
    """

    kwargs = _get_kwargs()

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
) -> JudgeTour | Problem | None:
    """What the Judge Mode tour shows

     The newest real records on this deployment: the demo operator's latest mandate with a captured
    purchase (its card and every purchase under it, blocked ones included), the latest sandbox dispute
    with a verdict, and the latest finished red-team campaign. Judges only.

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        JudgeTour | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
        )
    ).parsed
