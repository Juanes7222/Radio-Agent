/** HTTP error that the server funnel renders as JSON with this status. */
export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
