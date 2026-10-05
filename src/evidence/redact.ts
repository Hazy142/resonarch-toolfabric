const SENSITIVE_KEY=/(api[_-]?key|secret|token|password|passphrase|credential|authorization|cookie|private[_-]?key|access[_-]?key)/i;
export function redact(value:unknown):unknown{
 if(Array.isArray(value))return value.map(redact);
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,SENSITIVE_KEY.test(key)?"[REDACTED]":redact(item)]));
 if(typeof value==="string"&&/Bearer\s+\S+/i.test(value))return value.replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]");
 return value;
}
