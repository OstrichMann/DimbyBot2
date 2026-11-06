/** A song may occur more than once; source URI and catalog IDs cannot identify queue rows. */
export function queueEntryKey(track: { entryId: string }): string {
    return track.entryId
}
