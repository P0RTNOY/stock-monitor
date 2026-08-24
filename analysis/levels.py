from __future__ import annotations

from dataclasses import dataclass, field

from analysis.contracts import Bar, LevelZone, Pivot


@dataclass
class _Cluster:
    prices: list[float] = field(default_factory=list)
    pivots: list[Pivot] = field(default_factory=list)

    @property
    def center(self) -> float:
        return sum(self.prices) / len(self.prices)


def cluster_levels(
    pivots: tuple[Pivot, ...],
    bars: tuple[Bar, ...],
    *,
    latest_atr: float | None,
    width_atr_multiple: float,
    minimum_width_percent: float,
    minimum_touches: int,
    maximum_zones: int,
) -> tuple[LevelZone, ...]:
    if not bars or not pivots or latest_atr is None:
        return ()
    latest_close = bars[-1].close
    width = max(latest_atr * width_atr_multiple, latest_close * minimum_width_percent)
    if width <= 0:
        return ()

    clusters: list[_Cluster] = []
    for pivot in sorted(pivots, key=lambda item: item.price):
        eligible = [
            cluster
            for cluster in clusters
            if max(cluster.prices + [pivot.price])
            - min(cluster.prices + [pivot.price])
            <= width
        ]
        nearest = min(
            eligible,
            key=lambda cluster: abs(cluster.center - pivot.price),
            default=None,
        )
        if nearest is not None:
            nearest.prices.append(pivot.price)
            nearest.pivots.append(pivot)
        else:
            clusters.append(_Cluster(prices=[pivot.price], pivots=[pivot]))

    zones: list[LevelZone] = []
    for cluster in clusters:
        if len(cluster.pivots) < minimum_touches:
            continue
        cluster_span = max(cluster.prices) - min(cluster.prices)
        remaining_width = width - cluster_span
        lower = min(cluster.prices) - (remaining_width / 2)
        upper = max(cluster.prices) + (remaining_width / 2)
        if upper < latest_close:
            role = "support"
        elif lower > latest_close:
            role = "resistance"
        else:
            role = "decision"
        ordered_pivots = sorted(cluster.pivots, key=lambda item: item.timestamp)
        zones.append(
            LevelZone(
                role=role,
                lower=lower,
                upper=upper,
                center=cluster.center,
                touch_count=len(cluster.pivots),
                pivot_kinds=tuple(sorted({pivot.kind for pivot in cluster.pivots})),
                first_touch=ordered_pivots[0].timestamp,
                last_touch=ordered_pivots[-1].timestamp,
                distance_from_close_pct=abs((cluster.center - latest_close) / latest_close) * 100,
            )
        )

    ranked = sorted(
        zones,
        key=lambda zone: (-zone.touch_count, zone.distance_from_close_pct, -zone.last_touch.timestamp()),
    )[:maximum_zones]
    return tuple(sorted(ranked, key=lambda zone: zone.center))
