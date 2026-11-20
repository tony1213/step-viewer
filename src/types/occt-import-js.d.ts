declare module 'occt-import-js' {
  export interface OcctImportParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }

  /** See src/core/types.ts (OcctResult) for the full shape. */
  export interface OcctRawResult {
    success: boolean;
    [key: string]: unknown;
  }

  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctImportParams | null): OcctRawResult;
    ReadIgesFile(content: Uint8Array, params: OcctImportParams | null): OcctRawResult;
    ReadBrepFile(content: Uint8Array, params: OcctImportParams | null): OcctRawResult;
  }

  export default function occtimportjs(moduleArg?: { locateFile?: (path: string, prefix?: string) => string }): Promise<OcctModule>;
}
