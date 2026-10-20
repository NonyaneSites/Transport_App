import { supabase } from './supabase';

export type SharedSponsorship = {
  id: string;
  manifest_key: string;
  target_manifest_key: string;
  payer_passenger_id: string | null;
  payer_name: string;
  source_vehicle_id: string;
  source_vehicle_name: string;
  recipient_passenger_id: string;
  recipient_name: string;
  target_vehicle_id: string;
  target_vehicle_name: string;
  amount: number;
  note: string | null;
  status: 'active' | 'revoked';
};
const FIELDS = 'id,manifest_key,target_manifest_key,payer_passenger_id,payer_name,source_vehicle_id,source_vehicle_name,recipient_passenger_id,recipient_name,target_vehicle_id,target_vehicle_name,amount,note,status';
const keyFor = (id: string) => `crc_cross_taxi_revocation_${id}`;
export async function listSharedSponsorships(key: string): Promise<SharedSponsorship[]> {
  const { data, error } = await supabase.from('cross_taxi_sponsorships').select(FIELDS)
    .eq('target_manifest_key', key).eq('status', 'active');
  if (error) throw error;
  return (data ?? []) as unknown as SharedSponsorship[];
}
export async function createSharedSponsorship(input: {
  manifestKey: string; targetManifestKey: string; payerId?: string; payerName: string;
  sourceVehicleId: string; sourceVehicleName: string; recipientId: string; recipientName: string;
  targetVehicleId: string; targetVehicleName: string; amount: number; note?: string;
}): Promise<string> {
  if (!input.recipientId || !input.targetVehicleId) throw new Error('Select an existing target passenger and taxi');
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure random token unavailable');
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes).map(v => v.toString(16).padStart(2, '0')).join('');
  const { data, error } = await supabase.rpc('create_cross_taxi_sponsorship', {
    p_manifest_key: input.manifestKey, p_target_manifest_key: input.targetManifestKey,
    p_payer_passenger_id: input.payerId ?? null, p_payer_name: input.payerName,
    p_source_vehicle_id: input.sourceVehicleId, p_source_vehicle_name: input.sourceVehicleName,
    p_recipient_passenger_id: input.recipientId, p_recipient_name: input.recipientName,
    p_target_vehicle_id: input.targetVehicleId, p_target_vehicle_name: input.targetVehicleName,
    p_amount: input.amount, p_note: input.note ?? null, p_secret: secret,
  });
  if (error) throw error;
  const id = String(data);
  localStorage.setItem(keyFor(id), secret);
  return id;
}
export function canRevokeSharedSponsorship(id: string): boolean {
  return Boolean(localStorage.getItem(keyFor(id)));
}
export async function revokeSharedSponsorship(id: string): Promise<void> {
  const secret = localStorage.getItem(keyFor(id));
  if (!secret) throw new Error('Only the originating rep device may revoke this sponsorship. Contact an administrator for corrections.');
  const { error } = await supabase.rpc('revoke_cross_taxi_sponsorship', { p_id: id, p_secret: secret });
  if (error) throw error;
  localStorage.removeItem(keyFor(id));
}
