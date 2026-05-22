export interface KeysMapper {
	handleKeyPress(event: KeyboardEvent): Promise<void>;
}

export enum ViewType {
	Backlink = "backlink",
}
