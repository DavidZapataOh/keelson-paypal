/** The verification times at which every time bound a verification checked holds, inclusive. */
export interface Validity {
  notBefore: Date;
  notAfter: Date;
}

/** The intersection of `[from, to]` intervals. */
export function intersect(bounds: readonly (readonly [Date, Date])[]): Validity {
  return {
    notBefore: new Date(Math.max(...bounds.map(([from]) => from.getTime()))),
    notAfter: new Date(Math.min(...bounds.map(([, to]) => to.getTime()))),
  };
}

export const within = (v: Validity, at: Date) =>
  at.getTime() >= v.notBefore.getTime() && at.getTime() <= v.notAfter.getTime();
