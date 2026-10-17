import { v7 } from "uuid";

// uuid v7 é ordenável por tempo, ajuda o índice da PK
export const newId = (): string => v7();
