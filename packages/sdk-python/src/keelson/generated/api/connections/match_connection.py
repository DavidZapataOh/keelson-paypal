from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.match_connection_body import MatchConnectionBody
from ...models.match_connection_response_200 import MatchConnectionResponse200
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    code: str,
    *,
    body: MatchConnectionBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/connections/{code}/match".format(
            code=quote(str(code), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> MatchConnectionResponse200 | Problem | None:
    if response.status_code == 200:
        response_200 = MatchConnectionResponse200.from_dict(response.json())

        return response_200

    if response.status_code == 401:
        response_401 = Problem.from_dict(response.json())

        return response_401

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[MatchConnectionResponse200 | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    code: str,
    *,
    client: AuthenticatedClient,
    body: MatchConnectionBody,
) -> Response[MatchConnectionResponse200 | Problem]:
    """Pick the agent's number

     The user picks the number the agent shows beside its link out of the three the request offers. The
    right one opens the request; a wrong one denies it, since the link may not be the user's agent's.

    Args:
        code (str):
        body (MatchConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[MatchConnectionResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        code=code,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    code: str,
    *,
    client: AuthenticatedClient,
    body: MatchConnectionBody,
) -> MatchConnectionResponse200 | Problem | None:
    """Pick the agent's number

     The user picks the number the agent shows beside its link out of the three the request offers. The
    right one opens the request; a wrong one denies it, since the link may not be the user's agent's.

    Args:
        code (str):
        body (MatchConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        MatchConnectionResponse200 | Problem
    """

    return sync_detailed(
        code=code,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    code: str,
    *,
    client: AuthenticatedClient,
    body: MatchConnectionBody,
) -> Response[MatchConnectionResponse200 | Problem]:
    """Pick the agent's number

     The user picks the number the agent shows beside its link out of the three the request offers. The
    right one opens the request; a wrong one denies it, since the link may not be the user's agent's.

    Args:
        code (str):
        body (MatchConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[MatchConnectionResponse200 | Problem]
    """

    kwargs = _get_kwargs(
        code=code,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    code: str,
    *,
    client: AuthenticatedClient,
    body: MatchConnectionBody,
) -> MatchConnectionResponse200 | Problem | None:
    """Pick the agent's number

     The user picks the number the agent shows beside its link out of the three the request offers. The
    right one opens the request; a wrong one denies it, since the link may not be the user's agent's.

    Args:
        code (str):
        body (MatchConnectionBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        MatchConnectionResponse200 | Problem
    """

    return (
        await asyncio_detailed(
            code=code,
            client=client,
            body=body,
        )
    ).parsed
