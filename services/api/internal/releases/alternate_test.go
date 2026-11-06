package releases

import "testing"

func TestSameUpload(t *testing.T) {
	prowlarr := Release{Title: "Дальний космос / Stowaway [2021, США, фантастика, триллер, драма, WEB-DL] Dub (iTunes)", SizeBytes: 1565421568, Indexer: "RuTracker.org"}
	jacred := Release{Title: "Дальний космос / Stowaway (Джо Пенна / Joe Penna) [2021, США, фантастика, триллер, драма, WEB-DLRip] Dub (iTunes)", SizeBytes: 1567663063, Indexer: "RuTracker"}
	if _, ok := sameUpload(prowlarr, jacred); !ok {
		t.Fatal("same RuTracker topic from Prowlarr and Jacred not matched")
	}
	other := Release{Title: "Дальний космос / Stowaway (2021) WEB-DL 720p-iTunes", SizeBytes: 1566000000, Indexer: "BigFANGroup"}
	if _, ok := sameUpload(prowlarr, other); ok {
		t.Fatal("different upload of similar size matched")
	}
	same := other
	same.Indexer = "RuTracker"
	same.Title = "Безбилетный пассажир (2021) BDRip"
	if _, ok := sameUpload(prowlarr, same); ok {
		t.Fatal("different title on the same tracker matched")
	}
	bigger := jacred
	bigger.SizeBytes = 1600000000
	if _, ok := sameUpload(prowlarr, bigger); ok {
		t.Fatal("size 2 % apart matched")
	}
	ep := jacred
	ep.Episodes = []int{3}
	if _, ok := sameUpload(prowlarr, ep); ok {
		t.Fatal("different episode scope matched")
	}
}
