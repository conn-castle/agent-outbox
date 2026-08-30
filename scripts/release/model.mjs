/**
 * @typedef {{
 *   id: number,
 *   tagName: string,
 *   targetCommitish: string,
 *   draft: boolean,
 *   body: string,
 *   uploadUrl?: string,
 *   assets: { id: number, name: string, size: number }[]
 * }} GithubRelease
 */

/**
 * @param {unknown} raw
 * @returns {GithubRelease}
 */
export function normalizeGithubRelease(raw) {
  const release = /** @type {Record<string, any>} */ (raw ?? {});
  const id = Number(release.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("GitHub release is missing a numeric id");
  }
  const assets = Array.isArray(release.assets)
    ? release.assets.map((asset) => ({
        id: Number(asset.id),
        name: String(asset.name ?? ""),
        size: Number(asset.size ?? 0)
      }))
    : [];
  return {
    id,
    tagName: String(release.tag_name ?? release.tagName ?? ""),
    targetCommitish: String(
      release.target_commitish ?? release.targetCommitish ?? ""
    ),
    draft: Boolean(release.draft ?? release.isDraft),
    body: typeof release.body === "string" ? release.body : "",
    uploadUrl:
      typeof release.upload_url === "string"
        ? release.upload_url
        : typeof release.uploadUrl === "string"
          ? release.uploadUrl
          : undefined,
    assets
  };
}
