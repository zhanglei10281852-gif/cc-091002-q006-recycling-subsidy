export class SubsidyStore { transactions=[]; batches=new Map(); add(item){this.transactions.push(structuredClone(item));} saveBatch(key,batch){this.batches.set(key,structuredClone(batch));} }
