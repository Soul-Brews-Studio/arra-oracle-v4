import { type OwnerCore } from "./service.types";

export function mutateContextWrite<T>(core: OwnerCore, work: () => Promise<T>): Promise<T> {
return core.serial(work);
}
