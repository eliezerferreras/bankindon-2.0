export interface CsvRecord { line:number; values:string[] }
export interface CsvDocument { headers:string[]; records:CsvRecord[] }

export function parseCsvDocument(input:string):CsvDocument {
  const text=input.replace(/^\uFEFF/,'');
  const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;
  for(let index=0;index<text.length;index+=1){
    const char=text[index];
    if(quoted){
      if(char==='"'&&text[index+1]==='"'){cell+='"';index+=1;}
      else if(char==='"')quoted=false;
      else cell+=char;
    } else if(char==='"'&&cell.length===0) quoted=true;
    else if(char===','){row.push(cell);cell='';}
    else if(char==='\n'||char==='\r'){
      if(char==='\r'&&text[index+1]==='\n')index+=1;
      row.push(cell);cell='';
      if(row.some((value)=>value.trim()!==''))rows.push(row);
      row=[];
    } else cell+=char;
  }
  if(quoted)throw new Error('El CSV tiene un campo entre comillas que no se cerró.');
  if(cell.length||row.length){row.push(cell);if(row.some((value)=>value.trim()!==''))rows.push(row);}
  if(!rows.length)throw new Error('El archivo CSV está vacío.');
  const headers=rows[0].map((header)=>header.trim());
  return {headers,records:rows.slice(1).map((values,index)=>({line:index+2,values}))};
}

export function normalizeCsvHeader(value:string):string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
}

export function clientImportHeaderMap(headers:string[]):Record<string,number> {
  const aliases:Record<string,string[]>={
    firstName:['nombre','nombres','firstname'],
    lastName:['apellidos','apellido','lastname'],
    documentType:['tipodocumento','documenttype'],
    documentNumber:['identificacion','numeroidentificacion','numerodocumento','documentnumber','cedula'],
    phone:['telefono','celular','phone'],
    email:['correo','email'],
    address:['direccion','address'],
    status:['activo','estado','status'],
    countryCode:['paisdocumento','countrycode','documentcountry'],
  };
  const normalized=headers.map(normalizeCsvHeader);const map:Record<string,number>={};
  for(const [field,names] of Object.entries(aliases)){const index=normalized.findIndex((header)=>names.includes(header));if(index>=0)map[field]=index;}
  return map;
}

export function documentKey(type:string,number:string):string {
  const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  return `${normalize(type)}:${normalize(number)}`;
}
