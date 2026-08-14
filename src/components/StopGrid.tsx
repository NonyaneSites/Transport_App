import { MapPin, Users } from 'lucide-react';
import type { Passenger } from '@/lib/types';
import { passengersByStop, unassignedPassengers } from '@/lib/manifest';

interface Props {
  passengers: Passenger[];
}

export function StopGrid({ passengers }: Props) {
  const byStop = passengersByStop(passengers);
  const stops = Object.keys(byStop).sort((a, b) => byStop[b].length - byStop[a].length);
  const unassigned = unassignedPassengers({ date: '', signups: passengers, vehicles: [] }).length;

  if (stops.length === 0) {
    return (
      <div className="card">
        <div className="mb-4 flex items-center gap-2">
          <div className="h-5 w-1 rounded-full bg-crimson-500" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Stop Breakdown</h2>
        </div>
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <MapPin className="h-8 w-8 text-line" />
          <p className="text-sm text-muted">No signups yet. Upload a Microsoft Forms export to see stops.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-1 rounded-full bg-crimson-500" />
          <h2 className="font-display text-sm font-bold uppercase tracking-wider text-ink">Stop Breakdown</h2>
        </div>
        <span className="badge bg-card-2 text-muted">
          <Users className="h-3 w-3" />
          {passengers.length} total · {unassigned} unassigned
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stops.map((stop) => (
          <div
            key={stop}
            className="group relative overflow-hidden rounded-xl border border-line bg-card-2 p-4 transition-all hover:border-crimson-500/40"
          >
            <div className="absolute inset-y-0 left-0 w-1 bg-crimson-500/40 transition-all group-hover:bg-crimson-500" />
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-crimson-400" />
                <span className="text-sm font-semibold text-ink">{stop}</span>
              </div>
              <span className="font-display text-2xl font-bold text-crimson-400">{byStop[stop].length}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {byStop[stop].slice(0, 4).map((p) => (
                <span key={p.id} className="rounded-md bg-bg/60 px-1.5 py-0.5 text-[10px] text-muted">
                  {p.fullName.split(' ')[0]}
                </span>
              ))}
              {byStop[stop].length > 4 && (
                <span className="rounded-md bg-bg/60 px-1.5 py-0.5 text-[10px] text-muted">
                  +{byStop[stop].length - 4} more
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
