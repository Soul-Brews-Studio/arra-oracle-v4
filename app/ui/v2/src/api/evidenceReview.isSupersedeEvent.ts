import { type LifecycleEventRow } from "./evidenceReview";

export const isSupersedeEvent = (row: LifecycleEventRow): boolean => row.new_id !== null;
