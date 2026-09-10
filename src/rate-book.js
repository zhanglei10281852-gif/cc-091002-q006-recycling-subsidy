export class RateBook { constructor(versions){this.versions=versions;} current(material){return [...this.versions].reverse().find(x=>x.material===material);} }
