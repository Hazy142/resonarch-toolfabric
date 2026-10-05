import {randomUUID} from "node:crypto";
import type {Lease} from "./types.js";
export class LeaseBook{
 #generation=new Map<string,number>();
 #leases=new Map<string,Lease>();
 claim(node_id:string,worker_id:string,ttlMs=60000):Lease{
  const generation=(this.#generation.get(node_id)??0)+1;this.#generation.set(node_id,generation);
  const lease={lease_id:randomUUID(),node_id,worker_id,generation,fencing_token:randomUUID(),expires_at:Date.now()+ttlMs};
  this.#leases.set(node_id,lease);return lease;
 }
 assertCurrent(lease:Lease):void{
  const current=this.#leases.get(lease.node_id);
  if(!current||current.lease_id!==lease.lease_id||current.generation!==lease.generation||current.fencing_token!==lease.fencing_token||lease.expires_at<=Date.now())throw new Error("STALE_FENCING_TOKEN");
 }
}
