# Starlink desktop monitoring

This project helps one Starlink user investigate locally observed connection quality and history. Its language distinguishes the state of Starlink service from the desktop's ability to collect readings.

## Language

**Dish**:
The user's Starlink terminal, which reports local service state and telemetry.
_Avoid_: Serving satellite, space satellite

**Starlink router**:
The optional Starlink network and Wi-Fi device connected to the dish. Router diagnostics and dish telemetry have separate availability.

**Collection health**:
The desktop's ability to obtain current dish readings. A collection failure leaves current service health unknown.
_Avoid_: Service outage, disconnected internet

**Service health**:
The dish-reported service condition, including online, impaired, offline, or unknown. Local dish reachability alone does not establish it.

**Observed traffic**:
The rate of download or upload traffic flowing through the dish at a reading's observation time.
_Avoid_: Speed test, connection capacity, available bandwidth

**Dish uptime**:
The elapsed time reported by the dish since its last reboot. It does not establish uninterrupted internet service.

**Observed ping success**:
A quality percentage represented by valid ping measurements in the selected history window. Unmeasured time is excluded, so it does not establish continuous service uptime.
_Avoid_: Continuous service uptime, exact mobile-app uptime

**Reported outage**:
An interval supported by dish-reported offline observations, with a reason when available. The last confirmation and any observed recovery bound what is known about its duration.
_Avoid_: Collection gap, local RPC failure

**Collection gap**:
A period with no usable collected measurements. Service during that period is unmeasured.
_Avoid_: Healthy interval, confirmed outage

**Observation time**:
The time when the desktop captured a reading, including a response containing older dish history.
_Avoid_: Dish history sample time

**Estimated sample time**:
The approximate time of a dish history sample inferred from its counter and the local poll time. It is distinct from the time that history was captured.
_Avoid_: Dish-provided UTC timestamp

**Observed span**:
The earliest and latest available measurements within a selected history window. Gaps can still exist inside that span.
_Avoid_: Continuous coverage, guaranteed uptime

**Stale reading**:
A previously captured value that is too old to represent the current condition. Its source and observation time still describe the last known measurement.
_Avoid_: Current measurement

**Unavailable reading**:
A value that the connected equipment did not provide or that could not be interpreted reliably.
_Avoid_: Measured zero

**Obstruction signal map**:
Directional signal samples reported by the dish, with unsupported or invalid directions left unmeasured.
_Avoid_: Camera obstruction scan, exact physical obstruction outline, serving-satellite map

**GPS reception**:
The dish's reported GPS/GNSS reception, including a satellite count when available.
_Avoid_: Serving Starlink satellite count
