export class ModelJsonParseError extends SyntaxError {
  constructor(error, text) {
    super(error.message, { cause: error });
    this.name = 'ModelJsonParseError';
    this.responseExcerpt = text.slice(0, 12000);
  }
}
