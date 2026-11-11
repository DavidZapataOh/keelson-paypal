from http import HTTPStatus
from typing import Any
from urllib.parse import quote

import httpx2

from ... import errors
from ...client import AuthenticatedClient, Client
from ...models.card_chargeback import CardChargeback
from ...models.charge_back_purchase_body import ChargeBackPurchaseBody
from ...models.problem import Problem
from ...types import Response


def _get_kwargs(
    id: str,
    *,
    body: ChargeBackPurchaseBody,
) -> dict[str, Any]:
    headers: dict[str, Any] = {}

    _kwargs: dict[str, Any] = {
        "method": "post",
        "url": "/v1/purchases/{id}/chargeback".format(
            id=quote(str(id), safe=""),
        ),
    }

    _kwargs["json"] = body.to_dict()

    headers["Content-Type"] = "application/json"

    _kwargs["headers"] = headers
    return _kwargs


def _parse_response(
    *, client: AuthenticatedClient | Client, response: httpx2.Response
) -> CardChargeback | Problem | None:
    if response.status_code == 201:
        response_201 = CardChargeback.from_dict(response.json())

        return response_201

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
) -> Response[CardChargeback | Problem]:
    return Response(
        status_code=HTTPStatus(response.status_code),
        content=response.content,
        headers=response.headers,
        parsed=_parse_response(client=client, response=response),
    )


def sync_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
    body: ChargeBackPurchaseBody,
) -> Response[CardChargeback | Problem]:
    """Charge back a card purchase

     Files a chargeback through the card issuer over a card purchase's settled transaction, with the
    purchase's Alibi as the cardholder's evidence: Visa 13.1 or Mastercard 4853 for an item not
    received, Visa 13.3 or 4853 for one not as described, Visa 10.4 or Mastercard 4837 for a charge the
    user did not authorize. What the chargeback returns is subtracted from any bond claim over the
    purchase, and no bond claim is paid while it is open. Only the mandate's owner files it, one at a
    time.

    Args:
        id (str):
        body (ChargeBackPurchaseBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CardChargeback | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = client.get_httpx_client().request(
        **kwargs,
    )

    return _build_response(client=client, response=response)


def sync(
    id: str,
    *,
    client: AuthenticatedClient,
    body: ChargeBackPurchaseBody,
) -> CardChargeback | Problem | None:
    """Charge back a card purchase

     Files a chargeback through the card issuer over a card purchase's settled transaction, with the
    purchase's Alibi as the cardholder's evidence: Visa 13.1 or Mastercard 4853 for an item not
    received, Visa 13.3 or 4853 for one not as described, Visa 10.4 or Mastercard 4837 for a charge the
    user did not authorize. What the chargeback returns is subtracted from any bond claim over the
    purchase, and no bond claim is paid while it is open. Only the mandate's owner files it, one at a
    time.

    Args:
        id (str):
        body (ChargeBackPurchaseBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CardChargeback | Problem
    """

    return sync_detailed(
        id=id,
        client=client,
        body=body,
    ).parsed


async def asyncio_detailed(
    id: str,
    *,
    client: AuthenticatedClient,
    body: ChargeBackPurchaseBody,
) -> Response[CardChargeback | Problem]:
    """Charge back a card purchase

     Files a chargeback through the card issuer over a card purchase's settled transaction, with the
    purchase's Alibi as the cardholder's evidence: Visa 13.1 or Mastercard 4853 for an item not
    received, Visa 13.3 or 4853 for one not as described, Visa 10.4 or Mastercard 4837 for a charge the
    user did not authorize. What the chargeback returns is subtracted from any bond claim over the
    purchase, and no bond claim is paid while it is open. Only the mandate's owner files it, one at a
    time.

    Args:
        id (str):
        body (ChargeBackPurchaseBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        Response[CardChargeback | Problem]
    """

    kwargs = _get_kwargs(
        id=id,
        body=body,
    )

    response = await client.get_async_httpx_client().request(**kwargs)

    return _build_response(client=client, response=response)


async def asyncio(
    id: str,
    *,
    client: AuthenticatedClient,
    body: ChargeBackPurchaseBody,
) -> CardChargeback | Problem | None:
    """Charge back a card purchase

     Files a chargeback through the card issuer over a card purchase's settled transaction, with the
    purchase's Alibi as the cardholder's evidence: Visa 13.1 or Mastercard 4853 for an item not
    received, Visa 13.3 or 4853 for one not as described, Visa 10.4 or Mastercard 4837 for a charge the
    user did not authorize. What the chargeback returns is subtracted from any bond claim over the
    purchase, and no bond claim is paid while it is open. Only the mandate's owner files it, one at a
    time.

    Args:
        id (str):
        body (ChargeBackPurchaseBody):

    Raises:
        errors.UnexpectedStatus: If the server returns an undocumented status code and Client.raise_on_unexpected_status is True.
        httpx2.TimeoutException: If the request takes longer than Client.timeout.

    Returns:
        CardChargeback | Problem
    """

    return (
        await asyncio_detailed(
            id=id,
            client=client,
            body=body,
        )
    ).parsed
