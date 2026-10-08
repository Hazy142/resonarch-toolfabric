import {Ajv2020, type ErrorObject, type ValidateFunction} from "ajv/dist/2020.js";

export interface StandardSchemaWithJson {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | {value: unknown; issues?: undefined}
      | {issues: ReadonlyArray<{message: string; path?: ReadonlyArray<PropertyKey | {key: PropertyKey}>}>};
    readonly jsonSchema: {
      readonly input: () => Record<string, unknown>;
      readonly output: () => Record<string, unknown>;
    };
  };
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
  allowUnionTypes: true,
});

function issue(error: ErrorObject): {message: string; path?: ReadonlyArray<PropertyKey | {key: PropertyKey}>} {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .filter(Boolean)
    .map(part => ({key: part.replaceAll("~1", "/").replaceAll("~0", "~")}));
  return {
    message: `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    ...(path.length ? {path} : {}),
  };
}

export function standardJsonSchema(schema: Record<string, unknown>): StandardSchemaWithJson {
  const advertised = structuredClone(schema);
  const validate: ValidateFunction = ajv.compile(advertised);
  return {
    "~standard": {
      version: 1,
      vendor: "resonarch-toolfabric",
      validate: (value: unknown) => {
        if (validate(value)) return {value};
        return {issues: (validate.errors ?? []).map(issue)};
      },
      jsonSchema: {
        input: () => structuredClone(advertised),
        output: () => structuredClone(advertised),
      },
    },
  };
}
