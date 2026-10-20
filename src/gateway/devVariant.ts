declare const __GATEWAY_DEV__: boolean | undefined;

export const IS_DEV_VARIANT =
  typeof __GATEWAY_DEV__ !== "undefined" && __GATEWAY_DEV__;

declare const __GATEWAY_BUILD_TIME__: string | undefined;

export const BUILD_TIME =
  typeof __GATEWAY_BUILD_TIME__ !== "undefined"
    ? __GATEWAY_BUILD_TIME__
    : "unbundled";
