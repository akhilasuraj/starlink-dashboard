"""Small read-only binding for SpaceX's published local Device.GetDiagnostics request.

Wire numbers come from SpaceX's device-api/device.proto. Only the fields used by
this dashboard are described here; protobuf safely ignores newer fields.
https://github.com/SpaceExplorationTechnologies/enterprise-api/blob/master/device-api/device.proto
"""

from functools import lru_cache

import grpc
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory


SOURCE = "SpaceX Device API GetDiagnostics"
ROUTER_TARGET = "192.168.1.1:9000"
RPC_PATH = "/SpaceX.API.Device.Device/Handle"
ALERT_NAMES = (
    "dish_is_heating", "dish_thermal_throttle", "dish_thermal_shutdown",
    "power_supply_thermal_throttle", "motors_stuck", "mast_not_near_vertical",
    "slow_ethernet_speeds", "software_install_pending",
    "moving_too_fast_for_policy", "obstructed",
)


class DiagnosticsUnavailable(Exception):
    """The endpoint did not return the expected supported diagnostics response."""


@lru_cache(maxsize=1)
def message_types():
    file = descriptor_pb2.FileDescriptorProto()
    file.name = "starlink_dashboard_device_diagnostics.proto"
    file.package = "SpaceX.API.Device"
    file.syntax = "proto3"

    def message(name):
        item = file.message_type.add()
        item.name = name
        return item

    def field(owner, name, number, field_type, type_name=None, oneof_index=None):
        item = owner.field.add()
        item.name = name
        item.number = number
        item.label = descriptor_pb2.FieldDescriptorProto.LABEL_OPTIONAL
        item.type = field_type
        if type_name:
            item.type_name = f".SpaceX.API.Device.{type_name}"
        if oneof_index is not None:
            item.oneof_index = oneof_index

    string = descriptor_pb2.FieldDescriptorProto.TYPE_STRING
    boolean = descriptor_pb2.FieldDescriptorProto.TYPE_BOOL
    nested = descriptor_pb2.FieldDescriptorProto.TYPE_MESSAGE
    message("GetDiagnosticsRequest")
    request = message("Request")
    request.oneof_decl.add().name = "request"
    field(request, "get_diagnostics", 6000, nested, "GetDiagnosticsRequest", 0)
    alerts = message("DishAlerts")
    for number, name in enumerate(ALERT_NAMES, start=1):
        field(alerts, name, number, boolean)
    dish = message("DishGetDiagnosticsResponse")
    router = message("WifiGetDiagnosticsResponse")
    for owner in (dish, router):
        for number, name in enumerate(("id", "hardware_version", "software_version"), start=1):
            field(owner, name, number, string)
    field(dish, "alerts", 5, nested, "DishAlerts")
    response = message("Response")
    response.oneof_decl.add().name = "response"
    field(response, "wifi_get_diagnostics", 6000, nested, "WifiGetDiagnosticsResponse", 0)
    field(response, "dish_get_diagnostics", 6001, nested, "DishGetDiagnosticsResponse", 0)

    pool = descriptor_pool.DescriptorPool()
    pool.Add(file)
    return tuple(message_factory.GetMessageClass(pool.FindMessageTypeByName(f"SpaceX.API.Device.{name}"))
                 for name in ("Request", "Response"))


def get_diagnostics(target, kind, timeout=2.5):
    if kind not in ("dish", "router"):
        raise ValueError("kind must be dish or router")
    request_type, response_type = message_types()
    request = request_type()
    request.get_diagnostics.SetInParent()
    channel = grpc.insecure_channel(target)
    try:
        handle = channel.unary_unary(
            RPC_PATH, request_serializer=request_type.SerializeToString,
            response_deserializer=response_type.FromString,
        )
        response = handle(request, timeout=timeout)
    finally:
        channel.close()
    variant = "dish_get_diagnostics" if kind == "dish" else "wifi_get_diagnostics"
    if response.WhichOneof("response") != variant:
        raise DiagnosticsUnavailable(f"Expected {variant} response")
    details = getattr(response, variant)
    result = {name: getattr(details, name) or None
              for name in ("id", "hardware_version", "software_version")}
    if kind == "dish":
        result["alerts"] = ({name: bool(getattr(details.alerts, name)) for name in ALERT_NAMES}
                            if details.HasField("alerts") else None)
    return result
