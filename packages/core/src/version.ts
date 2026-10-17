/** Platform version constants surfaced in the UI, the SDK and diagnostics. */

export const PLATFORM_NAME = 'Moydan';
export const PLATFORM_VERSION = '0.1.0';
export const PLATFORM_HOME = 'https://github.com/hello2himel/moydan';

/** Version of the runtime bridge + SDK contract. */
export const SDK_VERSION = '1.0.0';
/** Version of the platform-native project format. */
export const PROJECT_FORMAT_VERSION = 1;
/** Version of the artefact manifest written into object storage. */
export const ARTIFACT_MANIFEST_VERSION = 1;

/**
 * Identity of the pinned build toolchain. Every artifact records the toolchain
 * that produced it, and build jobs are idempotent per (version tree, toolchain),
 * so a toolchain upgrade can never silently replace an artifact built with a
 * different compiler.
 *
 * The worker asserts at startup that the esbuild it loaded reports exactly
 * `BUILD_ESBUILD_VERSION` and refuses to build otherwise.
 */
export const BUILD_TOOLCHAIN_ID = 'moydan-build-1:esbuild-0.25.12:phaser-4.2.1';
export const BUILD_ESBUILD_VERSION = '0.25.12';
export const BUILD_PHASER_VERSION = '4.2.1';
