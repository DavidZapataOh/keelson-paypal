from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.judge_session import JudgeSession
from ...models.open_judge_session_body import OpenJudgeSessionBody
from ...models.problem import Problem
from ...types import UNSET, Response, Unset


def _get_kwargs(
    *,
    body: OpenJudgeSessionBody | Unset = UNSET,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/judge/sessions",
    }

    if not isinstance(body, Unset):
        _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> JudgeSession | Problem | None:
    if response.status_code == 201:
        response_201 = JudgeSession.from_dict(response.json())

        return response_201

    if response.status_code == 403:
        response_403 = Problem.from_dict(response.json())

        return response_403

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

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
) -> Response[JudgeSession | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: OpenJudgeSessionBody | Unset = UNSET,
) -> Response[JudgeSession | Problem]:
    """Open a Judge Mode session

     Creates a judge: a tenant with no email, no account and no key, signed in with a session cookie
    until the nightly reset after 12 hours. A judge reads the demo merchant's console (no changes),
    walks the tour, and can sign its own mandates with a passkey like any user. Five per hour per
    address, and a cap a day over every address that a judge with the invite is counted apart from.

    Args:
        body (OpenJudgeSessionBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[JudgeSession | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    *,
    client: AuthenticatedClient | Client,
    body: OpenJudgeSessionBody | Unset = UNSET,
) -> JudgeSession | Problem | None:
    """Open a Judge Mode session

     Creates a judge: a tenant with no email, no account and no key, signed in with a session cookie
    until the nightly reset after 12 hours. A judge reads the demo merchant's console (no changes),
    walks the tour, and can sign its own mandates with a passkey like any user. Five per hour per
    address, and a cap a day over every address that a judge with the invite is counted apart from.

    Args:
        body (OpenJudgeSessionBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        JudgeSession | Problem
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient | Client,
    body: OpenJudgeSessionBody | Unset = UNSET,
) -> Response[JudgeSession | Problem]:
    """Open a Judge Mode session

     Creates a judge: a tenant with no email, no account and no key, signed in with a session cookie
    until the nightly reset after 12 hours. A judge reads the demo merchant's console (no changes),
    walks the tour, and can sign its own mandates with a passkey like any user. Five per hour per
    address, and a cap a day over every address that a judge with the invite is counted apart from.

    Args:
        body (OpenJudgeSessionBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[JudgeSession | Problem]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient | Client,
    body: OpenJudgeSessionBody | Unset = UNSET,
) -> JudgeSession | Problem | None:
    """Open a Judge Mode session

     Creates a judge: a tenant with no email, no account and no key, signed in with a session cookie
    until the nightly reset after 12 hours. A judge reads the demo merchant's console (no changes),
    walks the tour, and can sign its own mandates with a passkey like any user. Five per hour per
    address, and a cap a day over every address that a judge with the invite is counted apart from.

    Args:
        body (OpenJudgeSessionBody | Unset):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        JudgeSession | Problem
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
