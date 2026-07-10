click section "HCR Cases and Outcomes"
toggle shortcuts panel 
click shortcutgroup "Searches"
click shortcutitem Searches > Person
enter "bo" as First Name
click button "Search"
click link in "Search Results" where Address = "14kl, Dakota, Minnesota, 55124"
click link in "Current Cases" where Type = "Insurance Affordability"
select nav "Evidence"
select navitem "Verifications"
select pagetab "Verified"
select pagetab "Outstanding"
expand row where Evidence Type = "Income"
expect "Description" is "Receives Wages before taxes of $789 Monthly"
collapse row where Evidence Type = "Income"
click rowmenu "Add Proof" where Evidence Type = "Income"
click button "Cancel"
