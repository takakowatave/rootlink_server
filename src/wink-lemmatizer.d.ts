declare module 'wink-lemmatizer' {
  interface Lemmatizer {
    verb(word: string): string;
    noun(word: string): string;
    adjective(word: string): string;
    lemmatizeVerb(word: string): string;
    lemmatizeNoun(word: string): string;
    lemmatizeAdjective(word: string): string;
  }

  const lemmatizer: Lemmatizer;
  export default lemmatizer;
}
