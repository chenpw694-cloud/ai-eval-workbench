import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Excel from 'exceljs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { fixture } from './helpers/formal-fixture.mjs';
import { parseQuestionsJson, questionsFromRows } from '../src/core/questions.ts';
import { questionHeaders, readExcelQuestions, readWordQuestions, preferredQuestionTable } from '../src/core/officeQuestions.ts';
import { questionsWorkbook, readableWorkbook } from '../src/core/readableWorkbook.ts';
import { questionsWord, reportWord } from '../src/core/wordReport.ts';
import { buildHandoff, unpackHandoff } from '../src/core/handoff.ts';
import { buildStagePackage, readStagePackage } from '../src/core/packages.ts';

const keys=['id','title','scene','category','difficulty','request','acceptance','referenceNames'];
const mapping=Object.fromEntries(keys.map((key,i)=>[key,questionHeaders[i]]));
const questions=parseQuestionsJson(JSON.stringify([{id:'Q-001',title:'精华液主图',scene:'白底主图',category:'美妆',difficulty:'基础',request:'保留 A&B <商品> 的文字，生成白底图。\n商品居中。',acceptance:['白底','瓶身清晰'],referenceNames:['1.png'],fields:{商品名称:'精华液'}}]));
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
const sha=v=>createHash('sha256').update(v).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
async function stage() {
 const b=fixture(2,2);b.project.schemeHash=sha(canonical(b.project.scheme));b.project.questionsHash=sha(canonical(b.project.questions));
 b.assets.forEach(a=>{a.sha256=sha(png);a.size=png.length;});b.evaluations.forEach(e=>{e.schemeHash=b.project.schemeHash;e.questionsHash=b.project.questionsHash;});
 return buildStagePackage({bundle:b,snapshots:[b.project],kind:'baseline',senderId:'m1',productIds:b.project.products.map(p=>p.id)},async id=>({...b.assets.find(a=>a.id===id),blob:new Blob([png],{type:'image/png'})}),{packageId:'office-roundtrip'});
}
test('Excel question export imports multiline Chinese fields, reference names and custom columns',async()=>{
 const blob=await questionsWorkbook(questions),tables=await readExcelQuestions(blob),table=tables[preferredQuestionTable(tables)];
 assert.equal(table.name,'题库');assert.deepEqual(questionsFromRows(table.headers,table.rows,mapping),questions);
});
test('Word question tables roundtrip Chinese text, XML characters, paragraph breaks and reference names',async()=>{
 const blob=await questionsWord(questions),tables=await readWordQuestions(blob),actual=questionsFromRows(tables[0].headers,tables[0].rows,mapping);
 assert.equal(actual[0].request,questions[0].request);assert.deepEqual(actual[0].acceptance,questions[0].acceptance);assert.deepEqual(actual[0].referenceNames,['1.png']);
});
test('Excel and Word empty templates contain only headers and no fake questions',async()=>{
 for(const [build,read] of [[questionsWorkbook,readExcelQuestions],[questionsWord,readWordQuestions]]){const tables=await read(await build([]));assert.deepEqual(tables[0].headers,questionHeaders);assert.equal(tables[0].rows.length,0);}
});
test('Excel import prefers the question sheet and does not evaluate formulas or accept stale cached values',async()=>{
 const wb=new Excel.Workbook();wb.addWorksheet('说明').addRow(['先填写题库']);const ws=wb.addWorksheet('题库');ws.addRow(questionHeaders);ws.addRow(['Q-1','','','','','需求','验收','']);
 let tables=await readExcelQuestions(new Blob([await wb.xlsx.writeBuffer()]));assert.equal(tables[preferredQuestionTable(tables)].name,'题库');
 ws.getCell('F2').value={formula:'"old"',result:'旧结果'};await assert.rejects(async()=>readExcelQuestions(new Blob([await wb.xlsx.writeBuffer()])),/粘贴为值/);
});
test('Excel exports strings beginning with equals as text, never executable formulas',async()=>{
 const q=structuredClone(questions);q[0].request='=HYPERLINK("https://example.invalid","商品")';const blob=await questionsWorkbook(q),wb=new Excel.Workbook();await wb.xlsx.load(await blob.arrayBuffer());assert.equal(wb.getWorksheet('题库').getCell('F2').type,Excel.ValueType.String);assert.equal(wb.getWorksheet('题库').getCell('F2').value,q[0].request);
});
test('Office import rejects renamed plain files and Word documents without a question table',async()=>{
 await assert.rejects(()=>readExcelQuestions(new Blob(['not an xlsx file at all....................'])),/Office/);
 const wb=await questionsWord([]),entries=unzipSync(new Uint8Array(await wb.arrayBuffer()));entries['word/document.xml']=strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>只有段落</w:t></w:r></w:p></w:body></w:document>');await assert.rejects(()=>readWordQuestions(new Blob([zipSync(entries)])),/未找到题目表格/);
});
test('report workbook retains typed scores, percentages, draft status and a reusable question sheet',async()=>{
 const b=fixture(2,2);b.evaluations[0].status='draft';const before=structuredClone(b),file=await readableWorkbook(b),wb=new Excel.Workbook();await wb.xlsx.load(await file.arrayBuffer());
 assert.deepEqual(wb.worksheets.map(s=>s.name),['结果汇总','维度得分','逐题评分','GSB对比','高频问题','交付检查','题库']);assert.equal(wb.getWorksheet('结果汇总').getCell('H5').type,Excel.ValueType.Number);assert.equal(wb.getWorksheet('结果汇总').getCell('H5').numFmt,'0.0%');assert.equal(wb.getWorksheet('逐题评分').getCell('F2').value,'草稿，不计入汇总');assert.equal(wb.getWorksheet('逐题评分').getCell('G2').value,null);assert.equal((await readExcelQuestions(file)).find(t=>t.name==='题库').rows.length,2);assert.deepEqual(b,before);
});
test('Word reports export real Office XML and explain missing data without fabricating a conclusion',async()=>{
 const b=fixture(2,2),before=structuredClone(b),blob=await reportWord(b,'original',async()=>undefined,'2026-10-22T12:00:00Z');const entries=unzipSync(new Uint8Array(await blob.arrayBuffer()));const xml=strFromU8(entries['word/document.xml']);assert(xml.includes('评测报告'));assert(xml.includes('人工结论尚未填写'));assert(xml.includes('质量与数据缺口'));assert(xml.includes('自家对比结果'));assert.deepEqual(b,before);
});
test('one handoff ZIP roundtrips the original stage files, records and media hashes',async()=>{
 const original=await stage(),preview=await readableWorkbook(original.manifest.bundle),packed=await buildHandoff(original.files,preview),files=await unpackHandoff([new File([packed],'发给成员.zip')]);
 assert.equal(files.length,original.files.length);for(const file of files)assert.equal(sha(Buffer.from(await file.arrayBuffer())),sha(Buffer.from(await original.files.find(f=>f.name===file.name).blob.arrayBuffer())));
 const imported=await readStagePackage([new File([packed],'发给成员.zip')]);assert.deepEqual(imported.manifest,original.manifest);assert.equal(imported.blobs.size,1);
 const entries=unzipSync(new Uint8Array(await packed.arrayBuffer()));assert(entries['评测明细.xlsx']);assert(strFromU8(entries['交接说明.txt']).includes('无需解压'));
});
test('modified or incomplete handoff packages fail before project import',async()=>{
 const original=await stage(),packed=await buildHandoff(original.files,new Blob(['readable preview'])),entries=unzipSync(new Uint8Array(await packed.arrayBuffer()));entries['评测明细.xlsx'][0]^=1;await assert.rejects(()=>unpackHandoff([new File([zipSync(entries)],'changed.zip')]),/已被修改/);
 delete entries['评测明细.xlsx'];await assert.rejects(()=>unpackHandoff([new File([zipSync(entries)],'missing.zip')]),/不完整/);
});
test('legacy JSON and media files remain accepted without converting their bytes',async()=>{
 const original=await stage(),files=original.files.map(f=>new File([f.blob],f.name));assert.deepEqual(await unpackHandoff(files),files);assert.deepEqual((await readStagePackage(files)).manifest,original.manifest);
});
test('one archive ZIP preserves the frozen report and original files for archive verification',async()=>{
 const {buildFinalArchive,readFinalArchive}=await import('../src/core/archive.ts');
 const original=await stage(),b=original.manifest.bundle;
 const record=await buildFinalArchive({bundle:b,snapshots:[b.project],audits:[]},{mode:'checkpoint',basis:'original',operatorId:'m1',reason:'合成格式验收',scopeConfirmed:true,featuresConfirmed:true,conclusionsConfirmed:true,demo:false},async id=>({...b.assets.find(a=>a.id===id),blob:new Blob([png],{type:'image/png'})}),{archiveId:'office-archive',now:'2026-10-22T12:00:00.000Z'});
 const packed=await buildHandoff(record.files),read=await readFinalArchive([new File([packed],'完整归档.zip')]);
 assert.deepEqual(read.record.manifest,record.manifest);assert.equal(read.report.status,'checkpoint');
 for(const file of read.record.files)assert.equal(sha(Buffer.from(await file.blob.arrayBuffer())),sha(Buffer.from(await record.files.find(f=>f.name===file.name).blob.arrayBuffer())));
});
test('demonstration downloads stay marked as simulated even when the example product flags are real',async()=>{
 const b=fixture(2,2),stamp='2026-10-22T12:00:00Z';
 const wb=new Excel.Workbook();await wb.xlsx.load(await (await readableWorkbook(b,'original',stamp,true)).arrayBuffer());
 assert.equal(wb.getWorksheet('结果汇总').getCell('D5').value,'模拟');assert(wb.getWorksheet('结果汇总').getCell('A2').value.includes('界面演示'));
 const word=unzipSync(new Uint8Array(await (await reportWord(b,'original',async()=>undefined,stamp,true)).arrayBuffer()));
 assert(strFromU8(word['word/document.xml']).includes('界面演示 · '));assert(strFromU8(word['word/document.xml']).includes('（模拟）'));
});
