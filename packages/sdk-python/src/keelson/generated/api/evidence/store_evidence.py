from http import HTTPStatus
from typing import Any

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.evidence_upload import EvidenceUpload
from ...models.problem import Problem
from ...models.store_evidence_response_201 import StoreEvidenceResponse201
from ...types import Response


def _get_kwargs(
    *,
    body: EvidenceUpload,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/evidence",
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Problem | StoreEvidenceResponse201 | None:
    if response.status_code == 201:
        response_201 = StoreEvidenceResponse201.from_dict(response.json())

        return response_201

    if response.status_code == 404:
        response_404 = Problem.from_dict(response.json())

        return response_404

    if response.status_code == 409:
        response_409 = Problem.from_dict(response.json())

        return response_409

    if response.status_code == 413:
        response_413 = Problem.from_dict(response.json())

        return response_413

    if response.status_code == 422:
        response_422 = Problem.from_dict(response.json())

        return response_422

    if response.status_code == 429:
        response_429 = Problem.from_dict(response.json())

        return response_429

    if client.raise_on_unexpected_status:
        raise errors.UnexpectedStatus(response.status_code, response.content)
    else:
        return None


def _build_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> Response[Problem | StoreEvidenceResponse201]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    *,
    client: AuthenticatedClient,
    body: EvidenceUpload,
) -> Response[Problem | StoreEvidenceResponse201]:
    """Store sealed evidence

     Stores what the agent saw at decision time for an active mandate of an operator this client linked
    or, for an app acting for a user, one that user approved for the app. The manifest is rebuilt from
    the items and must match, every item has its own salt, no public item may still hold an email
    address or phone number, and every `.original` must open with the evidence identity. A countersign
    may only bind a stored root, once.

    Args:
        body (EvidenceUpload):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | StoreEvidenceResponse201]
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
    client: AuthenticatedClient,
    body: EvidenceUpload,
) -> Problem | StoreEvidenceResponse201 | None:
    """Store sealed evidence

     Stores what the agent saw at decision time for an active mandate of an operator this client linked
    or, for an app acting for a user, one that user approved for the app. The manifest is rebuilt from
    the items and must match, every item has its own salt, no public item may still hold an email
    address or phone number, and every `.original` must open with the evidence identity. A countersign
    may only bind a stored root, once.

    Args:
        body (EvidenceUpload):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | StoreEvidenceResponse201
    """

    return sync_detailed(
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    *,
    client: AuthenticatedClient,
    body: EvidenceUpload,
) -> Response[Problem | StoreEvidenceResponse201]:
    """Store sealed evidence

     Stores what the agent saw at decision time for an active mandate of an operator this client linked
    or, for an app acting for a user, one that user approved for the app. The manifest is rebuilt from
    the items and must match, every item has its own salt, no public item may still hold an email
    address or phone number, and every `.original` must open with the evidence identity. A countersign
    may only bind a stored root, once.

    Args:
        body (EvidenceUpload):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[Problem | StoreEvidenceResponse201]
    """

    kwargs = _get_kwargs(
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    *,
    client: AuthenticatedClient,
    body: EvidenceUpload,
) -> Problem | StoreEvidenceResponse201 | None:
    """Store sealed evidence

     Stores what the agent saw at decision time for an active mandate of an operator this client linked
    or, for an app acting for a user, one that user approved for the app. The manifest is rebuilt from
    the items and must match, every item has its own salt, no public item may still hold an email
    address or phone number, and every `.original` must open with the evidence identity. A countersign
    may only bind a stored root, once.

    Args:
        body (EvidenceUpload):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Problem | StoreEvidenceResponse201
    """

    return (
        await asyncio_detailed(
            client=client,
            body=body,
        )
    ).parsed
